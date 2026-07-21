import { controlDb, tenantDb } from "../core/db.js";
import { ArmMetrics, ExperimentDoc, MetricsSnapshot } from "../core/types.js";
import { probVariantBeatsControlConv, probVariantBeatsControlRps, twoProportionZ } from "./stats.js";

interface ExposureRow {
  session_id: string;
  arm: string;
  timestamp: Date;
}

/**
 * Per-arm funnel for one experiment, joined on session_id over the tenant's
 * queries / product_clicks / cart / checkout_events, unified via session_aliases.
 * First-exposure attribution: a session belongs to the arm of its first
 * exposure row (unique index makes that the only row).
 */
export async function aggregateExperiment(exp: ExperimentDoc): Promise<MetricsSnapshot> {
  const db = await tenantDb(exp.dbName);
  const expId = String(exp._id);

  const exposures = (await db
    .collection("experiment_exposures")
    .find({ experiment_id: expId })
    .project({ session_id: 1, arm: 1, timestamp: 1 })
    .toArray()) as unknown as ExposureRow[];

  // alias map old→new and new→old so activity under either id is unified
  const aliases = (await db.collection("session_aliases").find({}).toArray()) as any[];
  const aliasOf = new Map<string, string>();
  for (const a of aliases) {
    aliasOf.set(a.old_session_id, a.new_session_id);
    aliasOf.set(a.new_session_id, a.old_session_id);
  }

  // canonical session = exposure session_id; ids to search = session + alias
  const armOfSession = new Map<string, { arm: string; since: Date }>();
  let contaminated = 0;
  for (const e of exposures) {
    const prior = armOfSession.get(e.session_id);
    if (prior && prior.arm !== e.arm) contaminated++;
    if (!prior || e.timestamp < prior.since) {
      armOfSession.set(e.session_id, { arm: e.arm, since: e.timestamp });
    }
  }
  // sessions whose alias landed in a different arm count as contaminated
  for (const [sid, info] of armOfSession) {
    const alias = aliasOf.get(sid);
    if (alias) {
      const other = armOfSession.get(alias);
      if (other && other.arm !== info.arm) contaminated++;
    }
  }

  const arms = new Map<string, { sessions: Set<string>; ids: string[] }>();
  for (const [sid, info] of armOfSession) {
    if (!arms.has(info.arm)) arms.set(info.arm, { sessions: new Set(), ids: [] });
    const a = arms.get(info.arm)!;
    a.sessions.add(sid);
    a.ids.push(sid);
    const alias = aliasOf.get(sid);
    if (alias && !armOfSession.has(alias)) a.ids.push(alias);
  }

  const startedAt = exp.statusHistory.find((h) => h.status === "running")?.at ?? exp.createdAt;
  const armMetrics: ArmMetrics[] = [];
  const revenueBySessionByArm = new Map<string, number[]>();

  for (const [armKey, { sessions, ids }] of arms) {
    const sessionMatch = { $in: ids };
    const timeMatch = { $gte: startedAt };

    const [searches, clicks, atcAgg, orderDocs] = await Promise.all([
      db.collection("queries").countDocuments({
        $or: [{ session_id: sessionMatch }, { sessionId: sessionMatch }],
        timestamp: timeMatch,
      }),
      db.collection("product_clicks").countDocuments({ session_id: sessionMatch, timestamp: timeMatch }),
      db
        .collection("cart")
        .aggregate([
          { $match: { session_id: sessionMatch, timestamp: timeMatch } },
          { $group: { _id: "$session_id" } },
        ])
        .toArray(),
      db
        .collection("checkout_events")
        .find({
          $or: [{ session_id: sessionMatch }, { "orderData.session_id": sessionMatch }],
          timestamp: timeMatch,
        })
        .project({ session_id: 1, "orderData.total_price": 1, "orderData.total": 1, total_price: 1, total: 1 })
        .toArray(),
    ]);

    let revenue = 0;
    const orderSessions = new Set<string>();
    const revBySession = new Map<string, number>();
    for (const o of orderDocs as any[]) {
      const sid = o.session_id ?? o.orderData?.session_id;
      const amt = Number(o.orderData?.total_price ?? o.orderData?.total ?? o.total_price ?? o.total ?? 0) || 0;
      revenue += amt;
      if (sid) {
        orderSessions.add(sid);
        revBySession.set(sid, (revBySession.get(sid) ?? 0) + amt);
      }
    }

    const n = sessions.size;
    const perSessionRevenue = ids.map((sid) => revBySession.get(sid) ?? 0);
    revenueBySessionByArm.set(armKey, perSessionRevenue);

    armMetrics.push({
      arm: armKey,
      sessions: n,
      searches,
      clicks,
      ctr: searches > 0 ? clicks / searches : 0,
      atcSessions: atcAgg.length,
      atcRate: n > 0 ? atcAgg.length / n : 0,
      orders: orderSessions.size,
      cvr: n > 0 ? orderSessions.size / n : 0,
      revenue,
      revenuePerSession: n > 0 ? revenue / n : 0,
    });
  }

  const control = armMetrics.find((a) => a.arm === "control");
  const variant = armMetrics.find((a) => a.arm !== "control");
  let stats: MetricsSnapshot["stats"];
  if (control && variant && control.sessions > 0 && variant.sessions > 0) {
    const { z, p } = twoProportionZ(control.orders, control.sessions, variant.orders, variant.sessions);
    stats = {
      zConv: z,
      pConv: p,
      probBestConv: probVariantBeatsControlConv(control.orders, control.sessions, variant.orders, variant.sessions),
      probBestRps: probVariantBeatsControlRps(
        revenueBySessionByArm.get(control.arm) ?? [],
        revenueBySessionByArm.get(variant.arm) ?? []
      ),
    };
  }

  const snapshot: MetricsSnapshot = {
    experimentId: expId,
    asOf: new Date(),
    arms: armMetrics.sort((a, b) => a.arm.localeCompare(b.arm)),
    contaminationRate: exposures.length > 0 ? contaminated / exposures.length : 0,
    stats,
  };

  const cdb = await controlDb();
  await cdb.collection("experiment_metrics").insertOne(snapshot as any);
  return snapshot;
}

export async function aggregateAllRunning(): Promise<void> {
  const cdb = await controlDb();
  const running = (await cdb
    .collection("experiments")
    .find({ status: "running" })
    .toArray()) as unknown as ExperimentDoc[];
  for (const exp of running) {
    try {
      await aggregateExperiment(exp);
    } catch (e) {
      console.error(`[metrics] aggregation failed for ${exp._id}:`, (e as Error).message);
    }
  }
}

import { Funnel, QueryRow } from './conversion.js';
import { StoreEvents } from './events.js';

/** A recorded count is useful evidence even when the rate's denominator cannot be trusted. */
export function measuredConversion(ev: StoreEvents, funnel: Funnel, rows: QueryRow[]) {
  const complete = (name: string) => ev.sources[name]?.status === 'ok' && !ev.sources[name].truncated;
  const c = funnel.coverage;
  const searches = complete('queries') && c.queries > 0 && c.queriesWithSession / c.queries >= 0.7;
  const click = searches && complete('product_clicks'), cart = searches && complete('cart');
  const checkout = searches && complete('checkout_events') && c.checkoutTracking;
  const purchase = searches && complete('checkout_events') && c.purchaseTracking && c.purchases > 0
    && c.purchasesWithSession / c.purchases >= 0.7
    && !(c.purchases >= 20 && c.purchaseSessionsSeenBefore !== null && c.purchaseSessionsSeenBefore < 0.3);
  return {
    funnel: { ...funnel, cartSessionsPurchaseRate: {
      ...funnel.cartSessionsPurchaseRate,
      withSearch: purchase ? funnel.cartSessionsPurchaseRate.withSearch : null,
      withoutSearch: purchase ? funnel.cartSessionsPurchaseRate.withoutSearch : null,
    }, rates: {
      click: click ? funnel.rates.click : null, cart: cart ? funnel.rates.cart : null,
      checkout: checkout ? funnel.rates.checkout : null, purchase: purchase ? funnel.rates.purchase : null,
    } },
    rows: rows.map(row => {
      const covered = row.searches > 0 && (row.searches - row.missingSession) / row.searches >= 0.7;
      return { ...row, clickRate: click && covered ? row.clickRate : null, cartRate: cart && covered ? row.cartRate : null, purchaseRate: purchase && covered ? row.purchaseRate : null };
    }),
  };
}

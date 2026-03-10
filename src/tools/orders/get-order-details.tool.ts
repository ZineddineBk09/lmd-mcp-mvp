import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { getOrderDetails } from '../../api/orders.api.js';
import type { OrderFood } from '../../api/orders.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

export const getOrderDetailsSchema = z.object({
  id: z.string().describe('Order ID — accepts either MongoDB _id (24-char hex) or human-readable YAF-... order_id'),
});

type GetOrderDetailsParams = z.infer<typeof getOrderDetailsSchema>;

const num = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = Number.parseFloat(v.replace(',', '.'));
    return Number.isFinite(p) ? p : fallback;
  }
  return fallback;
};

const str = (v: unknown, fallback = ''): string => (v != null ? String(v) : fallback);

const phone = (p: unknown): string => {
  if (!p || typeof p !== 'object') return '';
  const { code, number: n } = p as Record<string, unknown>;
  return [str(code), str(n)].filter(Boolean).join(' ');
};

const CANCELLED_STATUSES = [0, 2, 9, 10, 11, 90];

function formatFoodItem(food: OrderFood, currency: string) {
  const unitPrice = num(food.price);
  const qty = food.quantity ?? 1;
  const lineTotal = unitPrice * qty;
  const originalPrice = num(food.price_original, unitPrice);
  const hasOffer = food.offert === true;

  const addons = food.addons?.filter((a) => a.name).map((a) => `${a.name} (+${num(a.price)} ${currency})`) ?? [];

  const basePacks = (food as unknown as Record<string, unknown>).base_pack as Array<{ name?: string; isFree?: boolean; sub_pack?: Array<{ name?: string; price?: number }> }> | undefined;
  const basePackLines =
    basePacks?.map((bp) => {
      const subs = bp.sub_pack?.map((s) => `${s.name ?? 'Option'}: ${num(s.price)} ${currency}`).join(', ') ?? '';
      return `${bp.name ?? 'Base Pack'}${bp.isFree ? ' (Free)' : ''}${subs ? ` [${subs}]` : ''}`;
    }) ?? [];

  const typePackLines =
    food.type_pack?.map((tp) => {
      const subs = tp.sub_pack?.map((s) => `${s.name ?? 'Option'}: ${num(s.price)} ${currency}`).join(', ') ?? '';
      return `${tp.t_name ?? 'Type Pack'}${subs ? ` [${subs}]` : ''}`;
    }) ?? [];

  const offertFoods = (food as unknown as Record<string, unknown>).offert_food as Array<{ name?: string; quantity?: number; price?: number; price_original?: number }> | undefined;
  const offertLines =
    offertFoods?.map((o) => `${o.name ?? 'Item'} x${o.quantity ?? 1} — ${num(o.price)} ${currency}${num(o.price_original) > num(o.price) ? ` (was ${num(o.price_original)} ${currency})` : ''}`) ?? [];

  const result: Record<string, unknown> = {
    name: food.name,
    category: food.categoryname ?? food.main_category ?? 'N/A',
    quantity: qty,
    unit_price: `${unitPrice} ${currency}`,
    line_total: `${lineTotal} ${currency}`,
  };

  if (hasOffer && originalPrice > unitPrice) {
    result.original_price = `${originalPrice} ${currency}`;
    result.is_offer = true;
  }
  if (food.instruction?.trim()) result.instruction = food.instruction.trim();
  if (addons.length > 0) result.addons = addons;
  if (basePackLines.length > 0) result.base_packs = basePackLines;
  if (typePackLines.length > 0) result.type_packs = typePackLines;
  if (offertLines.length > 0) result.offered_items = offertLines;

  return result;
}

export async function getOrderDetailsHandler(params: GetOrderDetailsParams, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();

  if (ctx?.token) {
    client.updateToken(ctx.token);
  }

  const order = await getOrderDetails(client, params.id, ctx?.countryCode);

  const status = order.status;
  const statusLabel = ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`;

  const user = order.user as Record<string, unknown> | undefined;
  const userPhone = user?.phone as Record<string, unknown> | undefined;
  const userAddress = user?.address as Record<string, unknown> | undefined;

  const rest = order.restaurant as Record<string, unknown> | undefined;
  const restPhone = rest?.phone as Record<string, unknown> | undefined;
  const restPhone2 = rest?.phone2 as Record<string, unknown> | undefined;
  const restPhone3 = rest?.phone3 as Record<string, unknown> | undefined;
  const restAddress = rest?.address as Record<string, unknown> | undefined;

  const driver = order.driver as Record<string, unknown> | undefined;
  const driverPhone = driver?.phone as Record<string, unknown> | undefined;
  const driverAddress = driver?.address as Record<string, unknown> | undefined;

  const billings = order.billings as Record<string, unknown> | undefined;
  const clientBilling = (billings?.client ?? billings?.amount) as Record<string, unknown> | undefined;
  const amt = order.billings?.amount;
  const restBilling = order.billings?.restaurant;
  const driverBilling = (billings?.driver ?? order.billings?.driver) as Record<string, unknown> | undefined;
  const adminBilling = billings?.admin as Record<string, unknown> | undefined;
  const tipInfo = billings?.tip as Record<string, unknown> | undefined;
  const epayInfo = (billings?.epay ?? order.epayment) as Record<string, unknown> | undefined;

  const foods = order.foods ?? order.foods_purchased ?? [];
  const addr = order.delivery_address;

  const currency = str(restAddress?.currency_symbol) || str(userAddress?.currency_symbol) || str(order.country_details?.currency_symbol) || '';

  // -- Customer section --
  const customerName = [str(user?.first_name), str(user?.last_name)].filter(Boolean).join(' ') || str(user?.username) || 'N/A';
  const customerSection: Record<string, unknown> = {
    name: customerName,
    phone: phone(userPhone) || 'N/A',
  };
  if (user?.email) customerSection.email = str(user.email);
  if (user?.full_name && user.full_name !== customerName) customerSection.full_name = str(user.full_name);

  // -- Delivery address --
  const deliverySection: Record<string, unknown> = {};
  if (addr) {
    deliverySection.full_address = str(addr.fulladres) || str(addr.street) || 'N/A';
    if (addr.street) deliverySection.street = addr.street;
    if (addr.building) deliverySection.building = addr.building;
    if (addr.floor) deliverySection.floor = addr.floor;
    if (addr.door) deliverySection.door = addr.door;
    if (addr.landmark) deliverySection.landmark = addr.landmark;
    if (addr.type) deliverySection.type = addr.type;
    const extAddr = addr as Record<string, unknown>;
    if (extAddr.city) deliverySection.city = extAddr.city;
    if (extAddr.state) deliverySection.state = extAddr.state;
    if (extAddr.country) deliverySection.country = extAddr.country;
    if (extAddr.zipcode) deliverySection.zipcode = extAddr.zipcode;
    if (addr.loc?.lat && addr.loc?.lng) deliverySection.coordinates = { lat: Number(addr.loc.lat), lng: Number(addr.loc.lng) };
  }

  const deliveredPhones = order.delivered_phone_numbers;
  if (deliveredPhones?.length) deliverySection.delivery_phone = deliveredPhones[0];

  // -- For someone else --
  if (order.for_someone_else && order.ofse_details) {
    const ofse = order.ofse_details as Record<string, unknown>;
    deliverySection.for_someone_else = {
      receiver_name: str(ofse.receiver_name),
      receiver_phone: str(ofse.receiver_phone) || undefined,
    };
  }

  // -- Restaurant section --
  const restaurantSection: Record<string, unknown> = {
    name: str(rest?.restaurantname) || 'N/A',
    phone: phone(restPhone) || 'N/A',
  };
  const p2 = phone(restPhone2);
  if (p2) restaurantSection.phone2 = p2;
  const p3 = phone(restPhone3);
  if (p3 && p3.trim() !== 'null' && p3.trim() !== '') restaurantSection.phone3 = p3;
  if (rest?.email) restaurantSection.email = str(rest.email);
  if (restAddress) {
    restaurantSection.address = str(restAddress.fulladres) || 'N/A';
    if (restAddress.city) restaurantSection.city = str(restAddress.city);
    if (restAddress.state) restaurantSection.state = str(restAddress.state);
    if (restAddress.country) restaurantSection.country = str(restAddress.country);
  }
  if (rest?.store_type) restaurantSection.store_type = str(rest.store_type);
  if (rest?._id) restaurantSection.id = str(rest._id);

  // -- Driver section --
  let driverSection: Record<string, unknown> | null = null;
  if (driver?._id) {
    driverSection = {
      name: str(driver.username) || 'N/A',
      phone: phone(driverPhone) || 'N/A',
    };
    if (driver.email) driverSection.email = str(driver.email);
    if (driverAddress) {
      const parts = [driverAddress.line1, driverAddress.city, driverAddress.state, driverAddress.country].filter(Boolean).map((v) => str(v));
      if (parts.length > 0) driverSection.address = parts.join(', ');
    }
    const driverType = (driverBilling as Record<string, unknown>)?.driver_type as Record<string, unknown> | undefined;
    if (driverType?.name) driverSection.driver_type = str(driverType.name);
    driverSection.id = str(driver._id);
  }

  // -- Food items --
  const formattedItems = foods.map((f) => formatFoodItem(f, currency));

  // -- Billing / Order Summary --
  const foodTotal = num(clientBilling?.food_total) || num(amt?.total) || foods.reduce((s, f) => s + num(f.price) * (f.quantity ?? 1), 0);
  const deliveryCharge = num(clientBilling?.delivery_charge ?? amt?.delivery_amount);
  const originalDelivery = num(clientBilling?.original_delivery_charge);
  const serviceCharge = num(clientBilling?.service_charge ?? amt?.service_charge);
  const serviceTax = num(clientBilling?.service_tax ?? amt?.service_tax);
  const dropOffFee = num(clientBilling?.drop_off_additional_fees);
  const nightFee = num(clientBilling?.night_fare ?? clientBilling?.night_fee ?? amt?.night_fee);
  const surgeFee = num(clientBilling?.surge_fare ?? clientBilling?.surge_fee ?? amt?.surge_fee);
  const foodOfferPrice = num(clientBilling?.food_offer_price ?? amt?.food_offer_price);
  const restaurantOffer = num(clientBilling?.offer ?? amt?.offer_discount);
  const couponPrice = num(clientBilling?.coupon_price ?? amt?.coupon_discount);
  const clientTotal = num(clientBilling?.total ?? amt?.grand_total);

  const costBreakdown: Record<string, unknown> = {
    food_items_total: `${foodTotal} ${currency}`,
  };
  if (deliveryCharge) {
    costBreakdown.delivery_fee = `${deliveryCharge} ${currency}`;
    if (originalDelivery && Math.abs(deliveryCharge - originalDelivery) > 0.01) costBreakdown.original_delivery_fee = `${originalDelivery} ${currency}`;
  }
  if (dropOffFee) costBreakdown.drop_off_fee = `${dropOffFee} ${currency}`;
  if (serviceCharge) costBreakdown.service_charge = `${serviceCharge} ${currency}`;
  if (serviceTax) costBreakdown.service_tax = `${serviceTax} ${currency}`;
  if (nightFee) costBreakdown.night_fee = `${nightFee} ${currency}`;
  if (surgeFee) costBreakdown.surge_fee = `${surgeFee} ${currency}`;
  if (foodOfferPrice) costBreakdown.food_offer = `-${foodOfferPrice} ${currency}`;
  if (restaurantOffer) costBreakdown.restaurant_offer = `-${restaurantOffer} ${currency}`;

  // Coupon details
  if (couponPrice || order.coupon_code) {
    const couponDetail: Record<string, unknown> = {};
    if (couponPrice) couponDetail.discount = `-${couponPrice} ${currency}`;
    if (order.coupon_code) couponDetail.code = str(order.coupon_code);
    const cd = order.coupon_details as Record<string, unknown> | undefined;
    if (cd?.coupon_title) couponDetail.title = str(cd.coupon_title);
    if (cd?.type) couponDetail.type = str(cd.type);
    costBreakdown.coupon = couponDetail;
  }

  // Discount details
  const discountArr = (order as Record<string, unknown>).discount as Array<Record<string, unknown>> | undefined;
  if (order.discount_price || (discountArr?.length ?? 0) > 0) {
    const dd: Record<string, unknown> = {};
    if (order.discount_price) dd.amount = `-${Math.abs(num(order.discount_price))} ${currency}`;
    const disc = discountArr?.[0];
    if (disc) {
      if (disc.code || disc.name) dd.name = str(disc.code ?? disc.name);
      if (disc.discount_type) dd.type = str(disc.discount_type);
      if (disc.amount_percentage) dd.percentage = `${disc.amount_percentage}%`;
      if (disc.type) dd.source = str(disc.type);
    }
    costBreakdown.discount = dd;
  }

  // Tip
  if (tipInfo?.amount || tipInfo?.status) {
    const tipDetail: Record<string, unknown> = {};
    if (tipInfo.amount) tipDetail.amount = `${num(tipInfo.amount)} ${currency}`;
    if (tipInfo.status) tipDetail.status = str(tipInfo.status);
    costBreakdown.tip = tipDetail;
  }

  // Free delivery
  if (order.free_delivery_coupon_code) costBreakdown.free_delivery_coupon = str(order.free_delivery_coupon_code);
  if (order.yassir_plus) {
    const yp = order.yassir_plus as Record<string, unknown>;
    costBreakdown.yassir_plus = str(yp.type_yassir_plus ?? 'Active');
  }

  costBreakdown.grand_total = `${clientTotal} ${currency}`;

  // -- Payment --
  const paymentSection: Record<string, unknown> = {
    method: str(epayInfo?.method ?? epayInfo?.display_name) || 'CASH',
  };
  if (epayInfo?.display_name && epayInfo.display_name !== epayInfo.method) paymentSection.display_name = str(epayInfo.display_name);
  if (epayInfo?.status) paymentSection.status = str(epayInfo.status);
  if (epayInfo?.transaction_id) paymentSection.transaction_id = str(epayInfo.transaction_id);
  if (epayInfo?.secondary_payment_method) paymentSection.secondary_method = str(epayInfo.secondary_payment_method);
  const hybrid = epayInfo?.hybridPayment as Record<string, unknown> | undefined;
  if (hybrid) {
    if (hybrid.walletAmount != null) paymentSection.wallet_amount = `${num(hybrid.walletAmount)} ${currency}`;
    if (hybrid.paymentAmount != null) paymentSection.card_amount = `${num(hybrid.paymentAmount)} ${currency}`;
  }

  // -- Payouts --
  const payouts: Record<string, unknown> = {};
  if (restBilling?.restaurant_payout != null) payouts.restaurant_payout = `${num(restBilling.restaurant_payout)} ${currency}`;
  if (driverBilling?.driver_payout != null) payouts.driver_payout = `${num(driverBilling.driver_payout)} ${currency}`;
  if (adminBilling?.earnings != null) payouts.admin_earnings = `${num(adminBilling.earnings)} ${currency}`;
  if (typeof adminBilling?.adjustment === 'number' && adminBilling.adjustment !== 0) {
    payouts.admin_adjustment = `${adminBilling.adjustment > 0 ? '+' : ''}${num(adminBilling.adjustment)} ${currency}`;
    if (adminBilling.adjustment_comment) payouts.adjustment_comment = str(adminBilling.adjustment_comment);
  }
  if (adminBilling?.adjusted_earnings != null) payouts.adjusted_earnings = `${num(adminBilling.adjusted_earnings)} ${currency}`;

  // -- Flags & metadata --
  const flags: Record<string, unknown> = {};
  if (order.is_pickup_order) flags.is_pickup_order = true;
  if (order.isReadyForPickup) flags.is_ready_for_pickup = true;
  if (order.readyForPickupAt) flags.ready_for_pickup_at = order.readyForPickupAt;
  if (order.for_someone_else) flags.for_someone_else = true;
  if (order.fraud_suspecion) flags.fraud_suspicion = true;
  const raw = order as Record<string, unknown>;
  if (raw.has_delivery_issue) flags.has_delivery_issue = true;
  if (raw.is_scheduled) flags.is_scheduled = true;
  if (order.auto_accept_orders) {
    flags.auto_accept = true;
    if (order.auto_accept_orders_minutes) flags.auto_accept_minutes = order.auto_accept_orders_minutes;
  }
  if (order.coupon_code) flags.coupon_code = str(order.coupon_code);
  if (num(order.discount_price) > 0) flags.has_discount = true;
  if (order.yassir_plus) flags.yassir_plus = true;
  if (raw.app_version) flags.app_version = str(raw.app_version);
  if (CANCELLED_STATUSES.includes(status) && raw.cancellationreason) flags.cancellation_reason = str(raw.cancellationreason);

  // EPT
  const ept = raw.ept ?? raw.estimated_preparation_time;
  if (typeof ept === 'number' && ept > 0) flags.estimated_prep_time = `${ept} min`;

  // Only include non-empty sections
  const result: Record<string, unknown> = {
    order_id: order.order_id,
    _id: order._id,
    status: statusLabel,
    status_code: status,
    created_at: order.createdAt ?? null,
    customer: customerSection,
    delivery_address: Object.keys(deliverySection).length > 0 ? deliverySection : null,
    restaurant: restaurantSection,
    driver: driverSection ?? 'Not assigned',
    items: formattedItems,
    item_count: foods.length,
    cost_breakdown: costBreakdown,
    payment: paymentSection,
  };
  if (Object.keys(payouts).length > 0) result.payouts = payouts;
  if (Object.keys(flags).length > 0) result.flags = flags;

  result.country = order.country_details ?? {
    country_code: str(userAddress?.country_code) || str(restAddress?.country_code) || null,
    currency_symbol: currency || null,
  };

  const summary = `Order ${order.order_id} — ${statusLabel} | Customer: ${customerName} (${phone(userPhone) || 'N/A'}) | Restaurant: ${str(rest?.restaurantname) || 'N/A'} | ${foods.length} items | Total: ${clientTotal} ${currency} | Payment: ${paymentSection.method}`;

  return {
    result: {
      summary,
      order: result,
      display_hint:
        'IMPORTANT: Display the FULL order object using structured markdown. ' +
        'Show ALL sections: customer, delivery address, restaurant, driver, items (as table), ' +
        'cost breakdown (as table with each fee row), payment, payouts, and flags. ' +
        'Do NOT just show the summary — show every detail available in the order object.',
    },
    _debug: {
      query: `API POST /get/order-details { id: "${params.id}" }`,
      execution_time_ms: Date.now() - start,
      result_count: 1,
      timestamp: new Date().toISOString(),
    },
  };
}

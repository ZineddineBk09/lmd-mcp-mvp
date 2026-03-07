export const ORDER_STATUS = {
  DELETED: 0,
  ORDER_RECEIVED: 1,
  RESTAURANT_REJECTED_ORDER: 2,
  RESTAURANT_ACCEPTED: 3,
  DRIVER_REJECTED: 4,
  DRIVER_ACCEPTED: 5,
  DRIVER_PICKED_UP: 6,
  ORDER_DELIVERED: 7,
  PAYMENT_COMPLETED: 8,
  CANCELLED_BY_USER: 9,
  CANCELLED_BY_ADMIN: 10,
  ORDER_TIMEOUT: 11,
  NOT_AUTHORIZED: 13,
  PAYMENT_PENDING: 14,
  SCHEDULED: 15,
  DRIVER_AT_CLIENT: 16,
  DRIVER_AT_RESTAURANT: 17,
  CANCELLED_AFTER_PICKUP: 90,
} as const;

export const ORDER_STATUS_LABELS: Record<number, string> = {
  0: "Deleted",
  1: "Order Received",
  2: "Restaurant Rejected",
  3: "Restaurant Accepted",
  4: "Driver Rejected",
  5: "Driver Accepted",
  6: "Driver Picked Up",
  7: "Order Delivered",
  8: "Payment Completed",
  9: "Cancelled by User",
  10: "Cancelled by Admin",
  11: "Order Timeout",
  13: "Not Authorized",
  14: "Payment Pending",
  15: "Scheduled",
  16: "Driver at Client",
  17: "Driver at Restaurant",
  90: "Cancelled After Pickup",
};

export const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUS.ORDER_RECEIVED,
  ORDER_STATUS.RESTAURANT_ACCEPTED,
  ORDER_STATUS.DRIVER_ACCEPTED,
  ORDER_STATUS.DRIVER_PICKED_UP,
  ORDER_STATUS.DRIVER_AT_RESTAURANT,
] as const;

export const TERMINAL_ORDER_STATUSES = [
  ORDER_STATUS.ORDER_DELIVERED,
  ORDER_STATUS.CANCELLED_BY_USER,
  ORDER_STATUS.CANCELLED_BY_ADMIN,
  ORDER_STATUS.ORDER_TIMEOUT,
  ORDER_STATUS.RESTAURANT_REJECTED_ORDER,
  ORDER_STATUS.CANCELLED_AFTER_PICKUP,
] as const;

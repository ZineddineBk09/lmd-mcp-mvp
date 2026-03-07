// Fact-check script for Order Intelligence tools
// Run in mongosh connected to staging DB:
//   mongosh "<DB_URI>"
//   load("fact-check/orders.mongosh.js")

const COUNTRY = "DZ"; // Change to your target country

print("\n=== ORDER STATUS BREAKDOWN (last 24h) ===");
const since24h = new Date(Date.now() - 24 * 3600 * 1000);
const statusBreakdown = db.orders.aggregate([
  { $match: { country_code: COUNTRY, createdAt: { $gte: since24h } } },
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { _id: 1 } },
]).toArray();

const STATUS_LABELS = {
  0: "Deleted", 1: "Order Received", 2: "Restaurant Rejected", 3: "Restaurant Accepted",
  4: "Driver Rejected", 5: "Driver Accepted", 6: "Driver Picked Up", 7: "Order Delivered",
  8: "Payment Completed", 9: "Cancelled by User", 10: "Cancelled by Admin", 11: "Order Timeout",
  13: "Not Authorized", 14: "Payment Pending", 15: "Scheduled",
  16: "Driver at Client", 17: "Driver at Restaurant", 90: "Cancelled After Pickup"
};

statusBreakdown.forEach(s => {
  print(`  Status ${s._id} (${STATUS_LABELS[s._id] || "Unknown"}): ${s.count}`);
});

print("\n=== STUCK ORDERS (status=1, older than 15 min) ===");
const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
const stuckCount = db.orders.countDocuments({
  country_code: COUNTRY,
  status: 1,
  createdAt: { $lte: fifteenMinAgo }
});
print(`  Count: ${stuckCount}`);

print("\n=== TIMEOUTS TODAY ===");
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const timeouts = db.orders.countDocuments({
  country_code: COUNTRY,
  status: 11,
  updatedAt: { $gte: todayStart }
});
print(`  Count: ${timeouts}`);

print("\n=== NEEDS ATTENTION (unassigned > 5 min) ===");
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
const needsAttention = db.orders.aggregate([
  {
    $match: {
      country_code: COUNTRY,
      status: { $in: [3, 4, 5, 17] },
    }
  },
  {
    $addFields: {
      minutes_waiting: {
        $dateDiff: { startDate: "$createdAt", endDate: "$$NOW", unit: "minute" }
      },
      has_driver: {
        $cond: [{ $ifNull: ["$order_history.driver_accepted", false] }, true, false]
      }
    }
  },
  { $match: { has_driver: false, minutes_waiting: { $gt: 5 } } },
  { $count: "total" }
]).toArray();
print(`  Unassigned needing attention: ${needsAttention[0]?.total || 0}`);

print("\n=== ACTIVE ORDERS COUNT ===");
const activeCount = db.orders.countDocuments({
  country_code: COUNTRY,
  status: { $in: [1, 3, 5, 6, 17] }
});
print(`  Active orders: ${activeCount}`);

print("\n=== Done. Compare these numbers with MCP tool outputs. ===");

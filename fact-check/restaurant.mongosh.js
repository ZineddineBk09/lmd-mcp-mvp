// Fact-check script for Restaurant Health Intelligence tools
// Run in mongosh connected to staging DB:
//   mongosh "<DB_URI>"
//   load("fact-check/restaurant.mongosh.js")

const COUNTRY = "DZ"; // Change to your target country
const HOURS = 24;

const sinceDate = new Date(Date.now() - HOURS * 3600 * 1000);

print(`\n=== RESTAURANT HEALTH (last ${HOURS}h, ${COUNTRY}) ===`);

const results = db.orders.aggregate([
  { $match: { country_code: COUNTRY, createdAt: { $gte: sinceDate } } },
  {
    $group: {
      _id: "$restaurant_id",
      total: { $sum: 1 },
      accepted: {
        $sum: { $cond: [{ $in: ["$status", [3, 5, 6, 7, 8, 16, 17]] }, 1, 0] }
      },
      rejected: {
        $sum: { $cond: [{ $in: ["$status", [2, 11]] }, 1, 0] }
      },
      delivered: {
        $sum: { $cond: [{ $eq: ["$status", 7] }, 1, 0] }
      },
    }
  },
  {
    $addFields: {
      rejection_rate: {
        $cond: [
          { $gt: ["$total", 0] },
          { $round: [{ $multiply: [{ $divide: ["$rejected", "$total"] }, 100] }, 1] },
          0
        ]
      }
    }
  },
  { $sort: { rejection_rate: -1 } },
  { $limit: 10 }
]).toArray();

print("\nTop 10 worst rejection rates:");
results.forEach(r => {
  const info = db.restaurant.findOne({ _id: r._id }, { name: 1 });
  print(`  ${info?.name || r._id} — ${r.total} orders, ${r.rejected} rejected (${r.rejection_rate}%)`);
});

print("\n=== CURRENTLY AUTO-BUSY RESTAURANTS ===");
const autoBusy = db.restaurant.find(
  {
    "address.country_code": COUNTRY,
    "restaurantAvailability.isBusy": true,
  },
  { name: 1, restaurantAvailability: 1, "address.city": 1 }
).toArray();

print(`  Count: ${autoBusy.length}`);
autoBusy.forEach(r => {
  print(`  ${r.name} (${r.address?.city}) — busy until ${r.restaurantAvailability?.busyUntil}, post-rejection: ${r.restaurantAvailability?.isPostRejection}`);
});

print("\n=== AUTO-BUSY CITY CONFIG ===");
const cityConfig = db.cities.findOne(
  { country_code: COUNTRY },
  { busySettings: 1, maxRejectedOrders: 1, busyTime: 1, cityname: 1 }
);
if (cityConfig) {
  print(`  City: ${cityConfig.cityname}`);
  print(`  busySettings: ${cityConfig.busySettings}`);
  print(`  maxRejectedOrders: ${cityConfig.maxRejectedOrders}`);
  print(`  busyTime: ${cityConfig.busyTime} min`);
}

print("\n=== Done. Compare with MCP restaurant_health and auto_busy_predictions outputs. ===");

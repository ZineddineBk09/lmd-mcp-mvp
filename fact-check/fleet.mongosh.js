// Fact-check script for Fleet Intelligence tools
// Run in mongosh connected to staging DB:
//   mongosh "<DB_URI>"
//   load("fact-check/fleet.mongosh.js")

const COUNTRY = "DZ"; // Change to your target country
const STALE_THRESHOLD_MS = 300000; // 5 minutes

const freshThreshold = Date.now() - STALE_THRESHOLD_MS;

const baseFilter = {
  "address.country_code": COUNTRY,
  status: 1, // active account
};

print("\n=== FLEET STATUS ===");

const totalDrivers = db.drivers.countDocuments(baseFilter);
print(`  Total registered (active): ${totalDrivers}`);

const onlineDrivers = db.drivers.countDocuments({
  ...baseFilter,
  currentStatus: 1,
  logout: 0,
  last_update_time: { $gte: freshThreshold },
});
print(`  Online (fresh GPS): ${onlineDrivers}`);

const ghostDrivers = db.drivers.countDocuments({
  ...baseFilter,
  currentStatus: 1,
  logout: 0,
  last_update_time: { $lt: freshThreshold, $gt: 0 },
});
print(`  Ghost (online but stale GPS): ${ghostDrivers}`);

const offlineDrivers = db.drivers.countDocuments({
  ...baseFilter,
  $or: [{ currentStatus: 0 }, { logout: 1 }],
});
print(`  Offline: ${offlineDrivers}`);

print("\n=== GHOST DRIVER DETAILS (top 10) ===");
const ghosts = db.drivers.find(
  {
    ...baseFilter,
    currentStatus: 1,
    logout: 0,
    last_update_time: { $lt: freshThreshold, $gt: 0 },
  },
  { _id: 1, username: 1, last_update_time: 1, "address.city": 1 }
).sort({ last_update_time: 1 }).limit(10).toArray();

ghosts.forEach(d => {
  const minutesAgo = Math.round((Date.now() - d.last_update_time) / 60000);
  print(`  ${d.username || d._id} - ${d.address?.city} - last seen ${minutesAgo} min ago`);
});

print("\n=== Done. Compare these numbers with MCP fleet_status and ghost_drivers outputs. ===");

import mongoose from "mongoose";

let connected = false;

export async function connectMongoDB(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  const uri = process.env.DB_URI;
  if (!uri) {
    throw new Error("DB_URI environment variable is required");
  }

  await mongoose.connect(uri, {
    readPreference: "secondaryPreferred",
  });

  connected = true;
  return mongoose;
}

export function getMongoConnection(): typeof mongoose {
  if (!connected) {
    throw new Error("MongoDB not connected. Call connectMongoDB() first.");
  }
  return mongoose;
}

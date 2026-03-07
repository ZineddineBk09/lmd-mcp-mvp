import mongoose, { Schema, Document } from "mongoose";

export interface IDriver extends Document {
  currentStatus: number;
  logout: number;
  last_update_time: number;
  status: number;
  isReceiving: boolean;
  location: { lng: number; lat: number };
  address: {
    country_code: string;
    city: string;
  };
  driver_store_type: string[];
  currentOrders: {
    onGoingOrdersCount: number;
    processingOrdersCount: number;
    pickedUpOrdersCount: number;
  };
  username: string;
  fullname: string;
}

const driverSchema = new Schema(
  {
    currentStatus: { type: Number, default: 0 },
    logout: { type: Number, default: 0 },
    last_update_time: Number,
    status: { type: Number, default: 1 },
    isReceiving: { type: Boolean, default: false },
    location: {
      lng: Number,
      lat: Number,
    },
    address: {
      country_code: String,
      city: String,
    },
    driver_store_type: [String],
    currentOrders: {
      onGoingOrdersCount: { type: Number, default: 0 },
      processingOrdersCount: Number,
      pickedUpOrdersCount: { type: Number, default: 0 },
    },
    username: String,
    fullname: String,
  },
  { collection: "drivers", strict: false }
);

export const Driver =
  mongoose.models.Driver || mongoose.model<IDriver>("Driver", driverSchema);

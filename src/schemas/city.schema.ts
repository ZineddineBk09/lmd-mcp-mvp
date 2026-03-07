import mongoose, { Schema, Document } from "mongoose";

export interface ICity extends Document {
  auto_dispatch: boolean;
  dispatch_delay_time: number;
  max_dispatch_time: number;
  max_rejected_drivers: number;
  auto_dispatch_algorithm: string;
  driver_radius: number;
  max_orders: number;
  timer_config: {
    isEnabled: boolean;
    storeTimer: number;
    darkstoreTimer: number;
    restaurantTimer: number;
  };
  busySettings: boolean;
  maxRejectedOrders: number;
  busyTime: number;
  country_code: string;
  cityname: string;
  state: string;
}

const citySchema = new Schema(
  {
    auto_dispatch: Boolean,
    dispatch_delay_time: Number,
    max_dispatch_time: Number,
    max_rejected_drivers: Number,
    auto_dispatch_algorithm: { type: String, default: "normal" },
    driver_radius: { type: Number, default: 20 },
    max_orders: Number,
    timer_config: {
      isEnabled: { type: Boolean, default: false },
      storeTimer: { type: Number, default: 0 },
      darkstoreTimer: { type: Number, default: 0 },
      restaurantTimer: { type: Number, default: 0 },
    },
    busySettings: { type: Boolean, default: false },
    maxRejectedOrders: Number,
    busyTime: Number,
    country_code: String,
    cityname: String,
    state: String,
  },
  { collection: "cities", strict: false },
);

export const City =
  mongoose.models.City || mongoose.model<ICity>("City", citySchema);

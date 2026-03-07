import mongoose, { Schema, Document } from "mongoose";

export interface IRestaurant extends Document {
  status: number;
  restaurantAvailability: {
    isBusy: boolean;
    busyPeriodInMinutes?: number;
    busyUntil?: Date;
    isPostRejection: boolean;
  };
  store_type: string;
  address: {
    country_code: string;
    city: string;
  };
  name: string;
}

const restaurantSchema = new Schema(
  {
    status: { type: Number, default: 1 },
    restaurantAvailability: {
      isBusy: { type: Boolean, default: false },
      busyPeriodInMinutes: Number,
      busyUntil: Date,
      isPostRejection: { type: Boolean, default: false },
    },
    store_type: String,
    address: {
      country_code: String,
      city: String,
    },
    name: String,
  },
  { collection: "restaurant", strict: false }
);

export const Restaurant =
  mongoose.models.Restaurant ||
  mongoose.model<IRestaurant>("Restaurant", restaurantSchema);

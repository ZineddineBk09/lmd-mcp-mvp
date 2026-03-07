import mongoose, { Schema, Document } from "mongoose";

export interface IOrderHistory {
  food_delivered?: Date;
  driver_accepted?: Date;
  driver_pickedup?: Date;
  driver_at_restaurant?: Date;
  driver_at_client?: Date;
  order_time?: Date;
  restaurant_accepted?: Date;
  restaurant_rejected?: Date;
  driver_confirmed?: Date;
  driver_arrived?: Date;
}

export interface IOrder extends Document {
  status: number;
  country_code: string;
  main_city?: string;
  sub_city?: string;
  driver_id?: mongoose.Types.ObjectId;
  restaurant_id?: mongoose.Types.ObjectId;
  rejectedDriversList: mongoose.Types.ObjectId[];
  order_history: IOrderHistory;
  ept?: number;
  estimated_preparation_time?: number;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema(
  {
    status: { type: Number, default: 1 },
    country_code: String,
    main_city: String,
    sub_city: String,
    driver_id: { type: Schema.Types.ObjectId, ref: "drivers" },
    restaurant_id: { type: Schema.Types.ObjectId, ref: "restaurant" },
    rejectedDriversList: [Schema.Types.ObjectId],
    order_history: {
      food_delivered: Date,
      driver_accepted: Date,
      driver_pickedup: Date,
      driver_at_restaurant: Date,
      driver_at_client: Date,
      order_time: Date,
      restaurant_accepted: Date,
      restaurant_rejected: Date,
      driver_confirmed: Date,
      driver_arrived: Date,
    },
    ept: Number,
    estimated_preparation_time: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "orders", strict: false },
);

export const Order =
  mongoose.models.Order || mongoose.model<IOrder>("Order", orderSchema);

import { newId } from "../util.ts";

export interface VenueOrder {
  orderId: string;
  market: string;
  side: "buy" | "sell";
  quantity: string;
  limitPrice: string | null;
}

/**
 * Where ConDex submits a borrower's authorised order. Fills, cancels and rejections
 * come back later as execution events (POST /v1/execution/events), labelled with `name`.
 */
export interface ExecutionVenue {
  /** Evidence source label: "simulated", or "venue:<name>" for a live venue. */
  readonly name: string;
  submit(order: VenueOrder): { venueOrderId: string; accepted: boolean };
}

/** Accepts every order. Fills and cancellations are driven from the /v1/sim routes or the test page. */
export class SimulatedVenue implements ExecutionVenue {
  readonly name = "simulated";

  submit(_order: VenueOrder) {
    return { venueOrderId: newId("simord"), accepted: true };
  }
}

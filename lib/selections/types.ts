import "server-only";

export type SelectionStatus = "selected" | "sourcing" | "scheduled" | "closed";
export type ClosedReason = "aired" | "dropped" | "postponed";

export interface SelectionRow {
  id: string;
  discovered_product_id: string;
  status: SelectionStatus;
  owner_id: string;
  assignee_id: string | null;
  broadcast_id: string | null;
  closed_reason: ClosedReason | null;
  closed_at: string | null;
  closed_by: string | null;
  sourcing_note: string | null;
  scheduled_note: string | null;
  closed_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardCard extends SelectionRow {
  product: {
    name: string;
    thumbnail_url: string | null;
    price_jpy: number | null;
    category: string | null;
    source: string | null;
    tv_fit_score: number | null;
    product_url: string;
  };
  broadcast: {
    channel: string;
    air_date: string;
    start_time: string | null;
    program_title: string;
  } | null;
  owner: { display_name: string | null; email: string } | null;
  assignee: { display_name: string | null; email: string } | null;
}

export interface BoardData {
  selected: BoardCard[];
  sourcing: BoardCard[];
  scheduled: BoardCard[];
  closed: BoardCard[];
}

export interface ExpertSlot {
  starts_at: number;
  ends_at: number;
  timeframe_id: number;
  booking_id: number | null;
  booker_name: string | null;
  booker_email: string | null;
  room_id: number | null;
  is_mine: boolean;
}
export interface ExpertTimeframe {
  id: number;
  starts_at: number;
  ends_at: number;
  slot_duration_minutes: number;
}
export interface Expert {
  id: number;
  identity_id: number;
  name: string | null;
  email: string | null;
  profile_published: boolean;
  bio: string | null;
  pool_id: number | null;
  pool_name: string | null;
  room_ids: number[];
  timeframes: ExpertTimeframe[];
  slots: ExpertSlot[];
}
export interface ExpertPool {
  id: number;
  name: string;
  room_ids: number[];
  expert_count: number;
}

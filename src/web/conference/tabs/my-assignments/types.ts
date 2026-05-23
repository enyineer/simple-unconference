export type ScheduleSource = "unconference" | "static" | "mixer" | "expert";

export const SOURCE_LABEL: Record<ScheduleSource, string> = {
  unconference: "unconference",
  static: "planned",
  mixer: "mixer",
  expert: "expert",
};

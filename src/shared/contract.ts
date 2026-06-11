// Shared oRPC contract — single source of truth for every API operation.
// The server implementation MUST match these inputs/outputs; the frontend
// client is derived from the same shape. Drift between client and server
// surfaces as a TypeScript error at build time.
//
// Inputs are validated at runtime via the existing valibot schemas in
// `./schemas.ts`. Outputs are declared with oRPC's type-only `type<T>()`
// helper — no runtime validation (we trust our own server), but full
// TypeScript inference both directions: handlers must return the declared
// shape (compile error otherwise), and clients see exact return types.

import { oc, type } from "@orpc/contract";
import * as v from "valibot";
import {
  ChatResolveReportSchema,
  ChatSettingsUpdateSchema,
  MessageBody,
  PageInputEntries,
  ReportReason,
  BookExpertSchema,
  ConfLoginSchema,
  CreateConferenceSchema,
  CreateExpertPoolSchema,
  CreateExpertTimeframeSchema,
  CreateRoomSchema,
  CreateSlotSchema,
  CreateSubmissionSchema,
  DuplicateSlotSchema,
  InviteClaimSchema,
  InviteCreateSchema,
  InviteImportSchema,
  JoinLinkSetSchema,
  LoginSchema,
  ProfileDeleteAvatarSchema,
  ProfileGetSchema,
  ProfileListQuerySchema,
  ProfileUpdateAnySchema,
  ProfileUpdateMineSchema,
  PromoteExpertSchema,
  SignupSchema,
  SignupViaLinkSchema,
  SlotTypeSchema,
  ScheduleSubmissionSchema,
  PlacementPinSchema,
  TrackAssignmentSchema,
  TransferOwnershipSchema,
  UpdateConferenceSchema,
  UpdateConfMeSchema,
  UpdateExpertPoolSchema,
  UpdateExpertSchema,
  UpdateRoomSchema,
  UpdateSlotSchema,
  UpdateSlotSeriesSchema,
  UpdateSubmissionSchema,
} from "./schemas";

// Re-export every type, interface, and small input primitive from the split
// module so consumers can continue to `import { ... } from "../../shared/contract"`
// without any change.
export * from "./contract/types";

import {
  Id,
  InConf,
  Slug,
  type ChatBanOut,
  type ChatSettingsOut,
  type ConversationOut,
  type MessageOut,
  type MessageReportOut,
  type MessageReportSummaryOut,
  type Page,
  type AgendaOut,
  type AssignResult,
  type AssignAllResult,
  type CalendarOut,
  type ConfCreated,
  type ConfDetail,
  type ConfMeOut,
  type ConfSummary,
  type ExpertBookingCreatedOut,
  type ExpertOut,
  type ExpertPoolOut,
  type InviteImportOut,
  type InviteOut,
  type InvitePreviewOut,
  type JoinLinkOut,
  type MyAssignmentsOut,
  type NotificationListOut,
  type Ok,
  type ParticipantOut,
  type ProfileOut,
  type ProfileSummaryOut,
  type PublicConfigOut,
  type RoomOut,
  type ScheduleSubmissionResult,
  type SubmissionCreated,
  type SubmissionOut,
  type UpdateSeriesResult,
  type UserOut,
} from "./contract/types";

export const contract = {
  config: {
    get: oc.output(type<PublicConfigOut>()),
  },
  auth: {
    signup: oc.input(SignupSchema).output(type<UserOut>()),
    login: oc.input(LoginSchema).output(type<UserOut>()),
    logout: oc.output(type<Ok>()),
    me: oc.output(type<UserOut>()),
    // Self-service account deletion. Removes the calling owner's User row;
    // any conferences they still own become orphaned (ownerUserId -> null
    // per the schema's SetNull rule). Cookies are cleared. Used by the
    // loadtest teardown to leave instances clean after runs.
    deleteSelf: oc.output(type<Ok>()),
  },
  conferences: {
    list: oc.output(type<ConfSummary[]>()),
    create: oc.input(CreateConferenceSchema).output(type<ConfCreated>()),
    get: oc.input(InConf).output(type<ConfDetail>()),
    update: oc
      .input(v.object({ slug: Slug, ...UpdateConferenceSchema.entries }))
      .output(type<Ok>()),
    delete: oc.input(InConf).output(type<Ok>()),
    listParticipants: oc
      .input(v.object({ slug: Slug, ...PageInputEntries }))
      .output(type<Page<ParticipantOut>>()),
    removeParticipant: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),
    addModerator: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),
    removeModerator: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),

    // Hand ownership over to another existing global User. Owner-only.
    // The previous owner loses owner-level access; the new owner gets an
    // auto-minted ConferenceIdentity on their next visit.
    transferOwnership: oc
      .input(v.object({ slug: Slug, ...TransferOwnershipSchema.entries }))
      .output(type<Ok>()),

    // ----- invites (moderator+) -------------------------------------------
    createInvite: oc
      .input(v.object({ slug: Slug, ...InviteCreateSchema.entries }))
      .output(type<InviteOut>()),
    importInvites: oc
      .input(v.object({ slug: Slug, ...InviteImportSchema.entries }))
      .output(type<InviteImportOut>()),
    listInvites: oc
      .input(v.object({
        slug: Slug,
        status: v.optional(v.picklist(["pending", "claimed", "all"] as const)),
        ...PageInputEntries,
      }))
      .output(type<Page<InviteOut>>()),
    // Mod-only CSV export of pending invites. Streams every pending row
    // matching the optional `q` filter (no pagination) so big conferences
    // can hand the list to an external system without scraping pages.
    exportInvites: oc
      .input(v.object({
        slug: Slug,
        q: v.optional(v.pipe(v.string(), v.maxLength(128))),
      }))
      .output(type<{ invites: InviteOut[] }>()),
    revokeInvite: oc
      .input(v.object({ slug: Slug, id: Id }))
      .output(type<Ok>()),

    // ----- join link (owner-only) -----------------------------------------
    getJoinLink: oc.input(InConf).output(type<JoinLinkOut>()),
    setJoinLink: oc
      .input(v.object({ slug: Slug, ...JoinLinkSetSchema.entries }))
      .output(type<JoinLinkOut>()),
    rotateJoinLink: oc.input(InConf).output(type<JoinLinkOut>()),

    // ----- anonymous onboarding -------------------------------------------
    // No auth required; the token in the input is the secret.
    previewInvite: oc
      .input(v.object({ slug: Slug, token: v.pipe(v.string(), v.minLength(1)) }))
      .output(type<InvitePreviewOut>()),
    claimInvite: oc
      .input(v.object({ slug: Slug, ...InviteClaimSchema.entries }))
      .output(type<ConfMeOut>()),
    signupViaLink: oc
      .input(v.object({ slug: Slug, ...SignupViaLinkSchema.entries }))
      .output(type<ConfMeOut>()),

    // ----- per-conference identity session ---------------------------------
    login: oc
      .input(v.object({ slug: Slug, ...ConfLoginSchema.entries }))
      .output(type<ConfMeOut>()),
    logout: oc.input(InConf).output(type<Ok>()),
    me: oc.input(InConf).output(type<ConfMeOut>()),
    updateConfMe: oc
      .input(v.object({ slug: Slug, ...UpdateConfMeSchema.entries }))
      .output(type<ConfMeOut>()),

    // ----- per-identity calendar feed (one token per conference identity) --
    getCalendar: oc.input(InConf).output(type<CalendarOut>()),
    resetCalendar: oc.input(InConf).output(type<CalendarOut>()),
  },
  rooms: {
    // Paginated room list with free-text search across name/description/tags.
    // The Rooms tab uses this; agenda/sessions/experts/my-assignments pickers
    // need every room and call `listAll` instead.
    list: oc
      .input(v.object({ slug: Slug, ...PageInputEntries }))
      .output(type<Page<RoomOut>>()),
    // Unpaginated room list. Used by surfaces that have to enumerate every
    // room (slot pickers, session room-tag picker, expert/agenda views) and
    // would silently break if the table-view's pagination clipped the set.
    listAll: oc.input(InConf).output(type<RoomOut[]>()),
    create: oc.input(v.object({ slug: Slug, ...CreateRoomSchema.entries })).output(type<RoomOut>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateRoomSchema.entries }))
      .output(type<Ok>()),
    delete: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
  },
  submissions: {
    // Unpaginated list used by surfaces that have to enumerate every
    // visible submission (slot pickers, the schedule view's submission
    // lookup). Honors the same privacy gate as `list` (mods see all;
    // participants see published + own). `status` filter is mod-only.
    listAll: oc
      .input(v.object({
        slug: Slug,
        status: v.optional(v.picklist(["submitted", "published", "rejected"] as const)),
      }))
      .output(type<SubmissionOut[]>()),
    list: oc
      .input(v.object({
        slug: Slug,
        status: v.optional(v.picklist(["submitted", "published", "rejected"] as const)),
        // When true, restrict the listing to sessions the viewer has
        // personally starred. Server-side so paging works correctly even
        // when the starred set spans multiple pages.
        starred_only: v.optional(v.boolean()),
        // Tag chip filter with AND semantics — a session must carry every
        // listed tag to remain in the result set. Empty / omitted = no tag
        // constraint. Capped at 20 tags (parity with submission tag limit).
        tags: v.optional(v.pipe(
          v.array(v.pipe(v.string(), v.maxLength(48))),
          v.maxLength(20),
        )),
        ...PageInputEntries,
      }))
      .output(type<Page<SubmissionOut>>()),
    create: oc
      .input(v.object({ slug: Slug, ...CreateSubmissionSchema.entries }))
      .output(type<SubmissionCreated>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSubmissionSchema.entries }))
      .output(type<Ok>()),
    // Submitter can delete their own session while it's still `submitted`
    // (i.e. before a moderator has decided on it). Mods/owners can delete
    // any session in their conference.
    delete: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    publish: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    unpublish: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    reject: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    star: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    unstar: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
  },
  agenda: {
    get: oc.input(InConf).output(type<AgendaOut>()),
    createSlot: oc
      .input(v.object({ slug: Slug, ...CreateSlotSchema.pipe[0].entries }))
      .output(type<{ id: number }>()),
    updateSlot: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSlotSchema.pipe[0].entries }))
      .output(type<Ok>()),
    deleteSlot: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    // Duplicate an existing slot as a linked offering. If the source is
    // standalone, a new SlotSeries is created with the source + the new
    // sibling as members. If the source is already in a series, the new
    // sibling joins that series.
    duplicateSlot: oc
      .input(v.object({ slug: Slug, id: Id, ...DuplicateSlotSchema.pipe[0].entries }))
      .output(type<{ slot_id: number; series_id: number }>()),
    // Series-level config edit. Returns `needs_confirmation` when the patch
    // would orphan track assignments / placements; resubmit with `confirm: true`.
    updateSeries: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSlotSeriesSchema.entries }))
      .output(type<UpdateSeriesResult>()),
    // Promote a series member back to a standalone slot. Snapshots the
    // current series config onto the slot's own columns and clears
    // `series_id`. The series stays around for its remaining members.
    detachSeries: oc
      .input(v.object({ slug: Slug, slot_id: Id }))
      .output(type<Ok>()),
    // Delete a series. `mode = "series_only"` detaches all members first
    // (snapshotting config onto each). `mode = "with_slots"` cascade-deletes
    // every sibling slot too.
    deleteSeries: oc
      .input(v.object({
        slug: Slug, id: Id,
        mode: v.picklist(["series_only", "with_slots"] as const),
      }))
      .output(type<Ok>()),
    setTrack: oc
      .input(v.object({ slug: Slug, slot_id: Id, ...TrackAssignmentSchema.entries }))
      .output(type<Ok>()),
    // Same intent as `setTrack`, but the server picks the room based on the
    // Submission's pin (`preAssignedRoomId`), its `roomRequirements`, and
    // the largest free room in the slot's effective scope. Conflicts come
    // back as a structured payload — see `ScheduleSubmissionResult`.
    scheduleSubmission: oc
      .input(v.object({ slug: Slug, slot_id: Id, ...ScheduleSubmissionSchema.entries }))
      .output(type<ScheduleSubmissionResult>()),
    clearTrack: oc
      .input(v.object({ slug: Slug, slot_id: Id, room_id: Id }))
      .output(type<Ok>()),
    // Path C: per-track stars no longer exist. Participants star the
    // underlying Submission via `submissions.star` / `submissions.unstar`,
    // and every linked TrackAssignment derives onto their schedule. The
    // old `agenda.starTrack` / `agenda.unstarTrack` endpoints were removed.
    assign: oc
      .input(v.object({
        slug: Slug, slot_id: Id,
        // One-shot exclusion: drop these submissions from the slot's eligible
        // pool just for this assignment run (no persistent change to slot
        // config or to the submissions). The resolve panel uses this to
        // "skip" a conflicting pre-assigned session so its next-most-starred
        // alternative takes the room instead.
        exclude_submission_ids: v.optional(v.array(Id)),
      }))
      .output(type<AssignResult>()),
    // Moderator authors an unconference occurrence: place a session into a
    // slot + room. Room auto-picked when omitted. Conflicts come back as a
    // `ScheduleSubmissionResult` (same shape as `scheduleSubmission`).
    placeSubmission: oc
      .input(v.object({ slug: Slug, slot_id: Id, ...PlacementPinSchema.entries }))
      .output(type<ScheduleSubmissionResult>()),
    unplaceSubmission: oc
      .input(v.object({ slug: Slug, slot_id: Id, submission_id: Id }))
      .output(type<Ok>()),
    // Route attendees across the WHOLE agenda at once over the existing
    // placements (writes only UserAssignment rows; never moves placements).
    assignAll: oc.input(InConf).output(type<AssignAllResult>()),
    myAssignments: oc.input(InConf).output(type<MyAssignmentsOut>()),
    pickAssignment: oc
      .input(v.object({ slug: Slug, slot_id: Id, submission_id: Id }))
      .output(type<Ok>()),
    unpickAssignment: oc
      .input(v.object({ slug: Slug, slot_id: Id }))
      .output(type<Ok>()),
  },
  experts: {
    // ----- room pools (mod+) ---------------------------------------------
    listPools: oc.input(InConf).output(type<ExpertPoolOut[]>()),
    createPool: oc
      .input(v.object({ slug: Slug, ...CreateExpertPoolSchema.entries }))
      .output(type<ExpertPoolOut>()),
    updatePool: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateExpertPoolSchema.entries }))
      .output(type<Ok>()),
    deletePool: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),

    // ----- experts list (everyone) + management (mod+) -------------------
    list: oc.input(InConf).output(type<ExpertOut[]>()),
    promote: oc
      .input(v.object({ slug: Slug, ...PromoteExpertSchema.entries }))
      .output(type<{ id: number }>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateExpertSchema.entries }))
      .output(type<Ok>()),
    demote: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),

    // ----- timeframes (mod+) ---------------------------------------------
    createTimeframe: oc
      .input(v.object({
        slug: Slug, expert_id: Id, ...CreateExpertTimeframeSchema.pipe[0].entries,
      }))
      .output(type<{ id: number }>()),
    deleteTimeframe: oc
      .input(v.object({ slug: Slug, expert_id: Id, id: Id }))
      .output(type<Ok>()),

    // ----- bookings ------------------------------------------------------
    book: oc
      .input(v.object({ slug: Slug, ...BookExpertSchema.entries }))
      .output(type<ExpertBookingCreatedOut>()),
    cancelBooking: oc
      .input(v.object({ slug: Slug, booking_id: Id }))
      .output(type<Ok>()),
  },
  notifications: {
    list: oc.input(InConf).output(type<NotificationListOut>()),
    markRead: oc
      .input(v.object({ slug: Slug, id: Id }))
      .output(type<Ok>()),
    markAllRead: oc.input(InConf).output(type<Ok>()),
  },
  profiles: {
    // Fetch a single profile. Returns NOT_FOUND for non-mod viewers when the
    // profile is unpublished and not their own — same status as a truly
    // missing row, so existence isn't leaked.
    get: oc.input(ProfileGetSchema).output(type<ProfileOut>()),
    // Directory listing. Non-mod viewers see only `profilePublished=true`
    // identities; mods see everyone.
    list: oc.input(ProfileListQuerySchema).output(type<Page<ProfileSummaryOut>>()),
    // Self-edit: every identity may update their own profile fields and
    // entries/tags. Full-replacement semantics on entries/tags.
    updateMine: oc.input(ProfileUpdateMineSchema).output(type<ProfileOut>()),
    // Mod-edit-other: moderators/owners can edit any identity in their
    // conference. Cross-conference targets resolve to NOT_FOUND.
    updateAny: oc.input(ProfileUpdateAnySchema).output(type<ProfileOut>()),
    // Removes the avatar reference for self (or, for mods, for any target
    // identity in the conference). Phase 2 only nulls the DB column; the
    // on-disk file is cleaned up in Phase 3 via the avatar pipeline.
    deleteAvatar: oc.input(ProfileDeleteAvatarSchema).output(type<Ok>()),
  },
  // 1-on-1 conversations within a conference. See plans/chat.md for the
  // full privacy + eligibility rules. All procedures require at least a
  // participant role on the conference.
  chat: {
    // Inbox: every conversation the viewer is part of (including unaccepted
    // requests). Sorted by lastMessageAt desc; nulls (empty conversations)
    // last. Carries last-message preview + unread counts so the list view
    // doesn't need a follow-up fetch per row.
    listConversations: oc.input(InConf).output(type<ConversationOut[]>()),
    // Paginated upward: pass `before_id` to fetch older messages. Newest
    // first within each page so the UI can prepend on scroll-up.
    listMessages: oc
      .input(v.object({
        slug: Slug,
        conversation_id: Id,
        before_id: v.optional(Id),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
      }))
      .output(type<MessageOut[]>()),
    // Create a message. Auto-creates the Conversation row on first send.
    // Returns NOT_FOUND for unpublished targets to non-mods (mirrors
    // profiles.get) and FORBIDDEN otherwise. Rate-limited: see
    // src/server/lib/limits.ts chatMessagesPerMinute / chatNewConversationsPerHour.
    send: oc
      .input(v.object({
        slug: Slug,
        target_identity_id: Id,
        body: MessageBody,
      }))
      .output(type<MessageOut>()),
    edit: oc
      .input(v.object({ slug: Slug, message_id: Id, body: MessageBody }))
      .output(type<MessageOut>()),
    // Soft-deletes (sets deletedAt + deletedReason="user"). Body is null in
    // the returned MessageOut. Reports referencing this message still see
    // the original via the mod report payload.
    delete: oc
      .input(v.object({ slug: Slug, message_id: Id }))
      .output(type<MessageOut>()),
    markRead: oc
      .input(v.object({ slug: Slug, conversation_id: Id }))
      .output(type<Ok>()),
    acceptConversation: oc
      .input(v.object({ slug: Slug, conversation_id: Id }))
      .output(type<Ok>()),
    // Decline implies block: prevents the sender from re-initiating. The
    // receiver can clear the block later via unblockUser if they change
    // their mind.
    declineConversation: oc
      .input(v.object({ slug: Slug, conversation_id: Id }))
      .output(type<Ok>()),
    blockUser: oc
      .input(v.object({ slug: Slug, target_identity_id: Id }))
      .output(type<Ok>()),
    unblockUser: oc
      .input(v.object({ slug: Slug, target_identity_id: Id }))
      .output(type<Ok>()),
    reportMessage: oc
      .input(v.object({ slug: Slug, message_id: Id, reason: ReportReason }))
      .output(type<Ok>()),
    // Self chat settings. Toggles only — viewer can't set their own ban.
    getSettings: oc.input(InConf).output(type<ChatSettingsOut>()),
    updateSettings: oc
      .input(v.object({ slug: Slug, ...ChatSettingsUpdateSchema.entries }))
      .output(type<ChatSettingsOut>()),
  },
  // Moderation surface for chat reports + bans. All procedures require
  // moderator role on the conference.
  moderation: {
    listChatReports: oc
      .input(v.object({
        slug: Slug,
        status: v.optional(v.picklist(["open", "resolved", "all"] as const)),
        ...PageInputEntries,
      }))
      .output(type<Page<MessageReportSummaryOut>>()),
    // Mod-only full report payload (carries surrounding messages + edit
    // revisions). Called lazily when the mod opens a single report from the
    // paginated list so the list payload stays small.
    getChatReport: oc
      .input(v.object({ slug: Slug, report_id: Id }))
      .output(type<MessageReportOut>()),
    resolveChatReport: oc
      .input(v.object({
        slug: Slug,
        report_id: Id,
        ...ChatResolveReportSchema.entries,
      }))
      .output(type<Ok>()),
    listChatBans: oc
      .input(v.object({ slug: Slug, ...PageInputEntries }))
      .output(type<Page<ChatBanOut>>()),
    unbanFromChat: oc
      .input(v.object({ slug: Slug, identity_id: Id }))
      .output(type<Ok>()),
  },
};

export type Contract = typeof contract;

export { SlotTypeSchema };

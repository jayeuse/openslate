import type { z } from "zod";
import type * as schema from "./schemas";

// Schemas own wire fields. No legacy sample-domain identity or permission types.
export type CommsContext = Readonly<z.output<typeof schema.commsContextSchema>>;
export type Category = z.output<typeof schema.categorySchema>;
export type Conversation = z.output<typeof schema.conversationSchema>;
export type Channel = z.output<typeof schema.channelSchema>;
export type DirectConversation = z.output<typeof schema.directSchema>;
export type GroupConversation = z.output<typeof schema.groupSchema>;
export type Member = z.output<typeof schema.memberSchema>;
export type Message = z.output<typeof schema.messageSchema>;
export type LiveMessage = z.output<typeof schema.liveMessageSchema>;
export type Tombstone = z.output<typeof schema.tombstoneSchema>;
export type Thread = z.output<typeof schema.threadSchema>;
export type MessageRevision = z.output<typeof schema.messageRevisionSchema>;
export type Attachment = z.output<typeof schema.attachmentSchema>;
export type CommsFile = z.output<typeof schema.fileSchema>;
export type RecordReference = z.output<typeof schema.recordReferenceSchema>;
export type Bootstrap = z.output<typeof schema.bootstrapSchema>;
export type ConversationSummary = z.output<
  typeof schema.conversationSummarySchema
>;
export type MemberPreferences = z.output<typeof schema.memberPreferencesSchema>;
export type CategoryPreferences = z.output<
  typeof schema.categoryPreferencesSchema
>;
export type PersonalPreferences = z.output<
  typeof schema.personalPreferencesSchema
>;
export type ReadState = z.output<typeof schema.readStateSchema>;
export type SettingsScope = z.output<typeof schema.settingsScopeSchema>;
export type Settings = z.output<typeof schema.settingsSchema>;
export type SettingKey = z.output<typeof schema.settingKeySchema>;
export type Capability = z.output<typeof schema.capabilitySchema>;
export type CapabilityConfiguration = z.output<
  typeof schema.capabilityConfigurationSchema
>;
export type CapabilityLocks = z.output<typeof schema.capabilityLocksSchema>;
export type CapabilityCheck = z.output<typeof schema.capabilityCheckSchema>;
export type CapabilityDecision = z.output<
  typeof schema.capabilityDecisionSchema
>;
export type ChannelCreationScope = z.output<
  typeof schema.channelCreationScopeSchema
>;
export type ChannelCreationCheck = z.output<
  typeof schema.channelCreationCheckSchema
>;
export type SettingMetadata = z.output<typeof schema.settingMetadataSchema>;
export type SettingsResponse = z.output<typeof schema.settingsResponseSchema>;
export type DirectPolicy = z.output<typeof schema.directPolicySchema>;
export type PresenceSnapshot = z.output<typeof schema.presenceSnapshotSchema>;
export type CommsEvent = z.output<typeof schema.realtimeEventSchema>;
export type ConnectionState = z.output<typeof schema.connectionStateSchema>;
export type HttpFailure = z.output<typeof schema.commsFailureSchema>;
export type SendResult = z.output<typeof schema.sendResultSchema>;
export type HistoryPage = z.output<typeof schema.historyPageSchema>;
export type Report = z.output<typeof schema.reportSchema>;
export type Schedule = z.output<typeof schema.scheduleSchema>;
export type ExportJob = z.output<typeof schema.exportJobSchema>;
export type SearchHit = z.output<typeof schema.searchHitSchema>;
export type RetentionPolicy = z.output<typeof schema.retentionPolicySchema>;
export type RetentionResponse = z.output<typeof schema.retentionResponseSchema>;
export type RetentionPreview = z.output<typeof schema.retentionPreviewSchema>;
export type Template = z.output<typeof schema.templateSchema>;
export type TemplateApplyResult = z.output<
  typeof schema.templateApplyResultSchema
>;
export type TemplateApplyPreview = z.output<
  typeof schema.templateApplyPreviewSchema
>;
export type ConfigurationSnapshot = z.output<
  typeof schema.configurationSnapshotSchema
>;
export type ConfigurationHistory = z.output<
  typeof schema.configurationHistorySchema
>;
export type ConfigurationRestorePreview = z.output<
  typeof schema.configurationRestorePreviewSchema
>;
export type DirectBlock = z.output<typeof schema.directBlockSchema>;
export type CommsNotification = z.output<typeof schema.notificationSchema>;
export type PurgePreview = z.output<typeof schema.purgePreviewSchema>;
export type PurgeResult = z.output<typeof schema.purgeResultSchema>;

export type CategoryRequest = z.input<typeof schema.categoryRequestSchema>;
export type ChannelRequest = z.input<typeof schema.channelRequestSchema>;
export type ChannelPatch = z.input<typeof schema.channelPatchSchema>;
export type DirectRequest = z.input<typeof schema.directRequestSchema>;
export type GroupRequest = z.input<typeof schema.groupRequestSchema>;
export type SendMessageRequest = z.input<
  typeof schema.sendMessageRequestSchema
>;
export type SendReplyRequest = z.input<typeof schema.sendReplyRequestSchema>;
export type EditMessageRequest = z.input<
  typeof schema.editMessageRequestSchema
>;
export type ThreadPatch = z.input<typeof schema.threadPatchSchema>;
export type ReactionRequest = z.input<typeof schema.reactionRequestSchema>;
export type PinRequest = z.input<typeof schema.pinRequestSchema>;
export type FollowRequest = z.input<typeof schema.followRequestSchema>;
export type MarkReadRequest = z.input<typeof schema.markReadRequestSchema>;
export type MemberPreferencesPatch = z.input<
  typeof schema.memberPreferencesPatchSchema
>;
export type PersonalPreferencesRequest = z.input<
  typeof schema.personalPreferencesRequestSchema
>;
export type AttachmentReservation = z.input<
  typeof schema.attachmentReservationSchema
>;
export type SettingsPatch = z.input<typeof schema.settingsPatchSchema>;
export type SettingsReset = z.input<typeof schema.settingsResetSchema>;
export type SettingsLocks = z.input<typeof schema.settingsLocksSchema>;
export type ReportRequest = z.input<typeof schema.reportRequestSchema>;
export type RestrictionRequest = z.input<
  typeof schema.restrictionRequestSchema
>;
export type ScheduleRequest = z.input<typeof schema.scheduleRequestSchema>;
export type ExportRequest = z.input<typeof schema.exportRequestSchema>;
export type RetentionRequest = z.input<typeof schema.retentionRequestSchema>;
export type TemplateImport = z.input<typeof schema.templateImportSchema>;
export type TemplateApplyRequest = z.input<
  typeof schema.templateApplyRequestSchema
>;
export type MemberRoleRequest = z.input<typeof schema.memberRoleRequestSchema>;
export type DuplicateChannelRequest = z.input<
  typeof schema.duplicateChannelRequestSchema
>;
export type ConfigurationRestoreRequest = z.input<
  typeof schema.configurationRestoreRequestSchema
>;
export type PresenceRequest = z.input<typeof schema.presenceRequestSchema>;
export type PresenceListRequest = z.input<
  typeof schema.presenceListRequestSchema
>;
export type BlockRequest = z.input<typeof schema.blockRequestSchema>;
export type PurgeRequest = z.input<typeof schema.purgeRequestSchema>;
export type ConversationListRequest = z.input<
  typeof schema.conversationListRequestSchema
>;
export type CategoryListRequest = z.input<
  typeof schema.categoryListRequestSchema
>;
export type ThreadListRequest = z.input<typeof schema.threadListRequestSchema>;
export type TimeListRequest = z.input<typeof schema.timeListRequestSchema>;
export type MemberListRequest = z.input<typeof schema.memberListRequestSchema>;
export type HistoryRequest = z.input<typeof schema.historyRequestSchema>;
export type SearchRequest = z.input<typeof schema.searchRequestSchema>;

export type AccessGrantTarget = z.output<typeof schema.accessGrantTargetSchema>;
export type AccessGrantSubject = z.output<
  typeof schema.accessGrantSubjectSchema
>;
export type AccessGrantLevel = z.output<typeof schema.accessGrantLevelSchema>;
export type AccessGrant = z.output<typeof schema.accessGrantSchema>;
export type AccessGrantList = z.output<typeof schema.accessGrantListSchema>;
export type AccessCandidatesRequest = z.input<
  typeof schema.accessCandidatesRequestSchema
>;
export type AccessCandidates = z.output<typeof schema.accessCandidatesSchema>;

export type Page<T> = {
  items: T[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    total: number;
    has_more: boolean;
  };
};
/** Client-only metadata; HTTP bodies remain direct resources. */
export type Versioned<T> = { data: T; etag: string };
export type RequestOptions = { signal?: AbortSignal };
export type ConditionalOptions = RequestOptions &
  z.input<typeof schema.preconditionSchema>;
/** Ephemeral password supplied for this operation, never cached or persisted. */
export type FreshAdminOptions = RequestOptions & { password: string };
export type BinaryDownload = {
  bytes: Blob;
  filename: string;
  media_type: string;
};
export type UploadOptions = RequestOptions & {
  on_progress?: (progress: {
    loaded_bytes: number;
    total_bytes: number;
  }) => void;
};
export type RuntimeFailure =
  | { kind: "http"; failure: HttpFailure }
  | { kind: "network" }
  | { kind: "cancelled" }
  | { kind: "invalid_response" };
/** Promise rejections from an adapter implement this error contract. */
export type CommsClientError = Error & RuntimeFailure;
export type EventObserver = {
  on_event: (event: CommsEvent) => void;
  on_connection: (connection: ConnectionState) => void;
  on_error: (error: RuntimeFailure) => void;
};

import type * as C from "./types";

/** Shared view operations; the live runtime has explicit HTTP candidate/heartbeat DTOs. */
export type CommsViewClient = Omit<
  CommsClient,
  "listDirectCandidates" | "heartbeatPresence"
>;

/**
 * Frozen, accepted S01 v1 contract including the owner-approved D27 matrix.
 * No evaluator, transport or routes are implemented here. Authorization always
 * belongs to FastAPI; schemas validate contracts, never grant caller authority.
 *
 * Bind once to the signed-in user and organization; every HTTP call sends X-Org.
 * Reject responses outside that context and dispose on account/org switch.
 * Inputs are snake_case JSON; signals, progress, ETag and binary bytes are not.
 * Failures reject with CommsClientError, never a success-shaped empty response.
 */
export interface CommsClient {
  readonly context: C.CommsContext;
  readonly events: {
    subscribe(
      observer: C.EventObserver,
      options?: C.RequestOptions,
    ): () => void;
  };

  // Bootstrap composes Inbox/quick-switcher; Activity composes notifications.
  // Person/department/group/module/record pickers use existing authorized APIs.
  bootstrap(options?: C.RequestOptions): Promise<C.Bootstrap>;
  /** Phase A read projection; S21/S26 use the existing notifications API. */
  listActivity(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.CommsNotification>>;
  /** Phase A metadata only; eligibility is rechecked again by direct/group writes. */
  listDirectCandidates(
    request?: C.MemberListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<Pick<C.Member, "user_id" | "display_name">>>;
  listConversations(
    request?: C.ConversationListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Conversation>>;
  getConversation(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Conversation>>;
  listCategories(
    request?: C.CategoryListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Category>>;
  getCategory(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Category>>;
  createCategory(
    request: C.CategoryRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Category>>;
  updateCategory(
    id: string,
    request: C.CategoryRequest,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Category>>;
  createChannel(
    request: C.ChannelRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Channel>>;
  updateChannel(
    id: string,
    request: C.ChannelPatch,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Channel>>;
  archiveConversation(
    id: string,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Conversation>>;
  restoreConversation(
    id: string,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Conversation>>;
  findOrCreateDirect(
    request: C.DirectRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.DirectConversation>>;
  createGroup(
    request: C.GroupRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.GroupConversation>>;
  listMembers(
    conversationId: string,
    request?: C.MemberListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Member>>;
  setMemberRole(
    conversationId: string,
    userId: string,
    request: C.MemberRoleRequest,
    options: C.ConditionalOptions,
  ): Promise<C.Member>;
  removeMember(
    conversationId: string,
    userId: string,
    options: C.ConditionalOptions,
  ): Promise<void>;
  /** Copies settings and access, never messages; rechecks target createChannel too. */
  duplicateChannel(
    conversationId: string,
    request: C.DuplicateChannelRequest,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Channel>>;
  listDirectBlocks(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.DirectBlock>>;
  blockDirect(
    request: C.BlockRequest,
    options?: C.RequestOptions,
  ): Promise<void>;
  unblockDirect(userId: string, options?: C.RequestOptions): Promise<void>;

  getPersonalPreferences(
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.PersonalPreferences>>;
  // Preference writes are last-write-wins. Legacy conditional options remain
  // source-compatible, but their if_match value is never evaluated or sent.
  setPersonalPreferences(
    request: C.PersonalPreferencesRequest,
    options?: C.RequestOptions | C.ConditionalOptions,
  ): Promise<C.Versioned<C.PersonalPreferences>>;
  getMemberPreferences(
    conversationId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.MemberPreferences>>;
  updateMemberPreferences(
    conversationId: string,
    request: C.MemberPreferencesPatch,
    options?: C.RequestOptions | C.ConditionalOptions,
  ): Promise<C.Versioned<C.MemberPreferences>>;
  setCategoryPreferences(
    categoryId: string,
    request: C.CategoryPreferences,
    options?: C.RequestOptions | C.ConditionalOptions,
  ): Promise<C.Versioned<C.CategoryPreferences>>;
  getCategoryPreferences(
    categoryId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.CategoryPreferences>>;
  /** Monotonic max; explicit action/new visible engagement clears manual_unread. */
  markRead(
    conversationId: string,
    request: C.MarkReadRequest,
    options?: C.RequestOptions,
  ): Promise<C.ReadState>;

  /** Ascending, sparse seq; before/after are exclusive; around includes its target. */
  getHistory(
    conversationId: string,
    request?: C.HistoryRequest,
    options?: C.RequestOptions,
  ): Promise<C.HistoryPage>;
  getMessage(
    conversationId: string,
    messageId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Message>>;
  /** Resolves the exact seq named by an id-only message event. */
  getMessageBySequence(
    conversationId: string,
    seq: number,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Message>>;
  sendMessage(
    conversationId: string,
    request: C.SendMessageRequest,
    options?: C.RequestOptions,
  ): Promise<C.SendResult>;
  editMessage(
    conversationId: string,
    messageId: string,
    request: C.EditMessageRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.LiveMessage>>;
  deleteMessage(
    conversationId: string,
    messageId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Tombstone>>;
  listMessageRevisions(
    conversationId: string,
    messageId: string,
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.MessageRevision>>;
  getThread(
    conversationId: string,
    rootMessageId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Thread>>;
  createThread(
    conversationId: string,
    rootMessageId: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Thread>>;
  getReplies(
    conversationId: string,
    rootMessageId: string,
    request?: C.HistoryRequest,
    options?: C.RequestOptions,
  ): Promise<C.HistoryPage>;
  sendReply(
    conversationId: string,
    rootMessageId: string,
    request: C.SendReplyRequest,
    options?: C.RequestOptions,
  ): Promise<C.SendResult>;
  updateThread(
    conversationId: string,
    rootMessageId: string,
    request: C.ThreadPatch,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Thread>>;
  followThread(
    conversationId: string,
    rootMessageId: string,
    request: C.FollowRequest,
    options?: C.RequestOptions,
  ): Promise<C.Thread>;
  listThreads(
    request?: C.ThreadListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Thread>>;
  addReaction(
    conversationId: string,
    messageId: string,
    request: C.ReactionRequest,
    options?: C.RequestOptions,
  ): Promise<C.Message>;
  removeReaction(
    conversationId: string,
    messageId: string,
    request: C.ReactionRequest,
    options?: C.RequestOptions,
  ): Promise<C.Message>;
  setPin(
    conversationId: string,
    messageId: string,
    request: C.PinRequest,
    options?: C.RequestOptions,
  ): Promise<C.Message>;
  listPins(
    conversationId: string,
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Message>>;

  reserveAttachment(
    conversationId: string,
    request: C.AttachmentReservation,
    options?: C.RequestOptions,
  ): Promise<C.CommsFile>;
  uploadAttachment(
    conversationId: string,
    fileId: string,
    bytes: Blob,
    options?: C.UploadOptions,
  ): Promise<C.CommsFile>;
  downloadAttachment(
    conversationId: string,
    fileId: string,
    options?: C.RequestOptions,
  ): Promise<C.BinaryDownload>;
  getRecordReference(
    conversationId: string,
    referenceId: string,
    options?: C.RequestOptions,
  ): Promise<C.RecordReference>;
  /** Recent linked records from readable conversations, not a new follow table. */
  listLinkedRecords(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.RecordReference>>;

  getSettings(
    scope: C.SettingsScope,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.SettingsResponse>>;
  updateSettings(
    scope: C.SettingsScope,
    request: C.SettingsPatch,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.SettingsResponse>>;
  resetSettings(
    scope: C.SettingsScope,
    request: C.SettingsReset,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.SettingsResponse>>;
  setSettingsLocks(
    request: C.SettingsLocks,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.SettingsResponse>>;
  getCapabilityConfiguration(
    scope: C.SettingsScope,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.CapabilityConfiguration>>;
  /** Replaces local rows only; never removes an ancestor's grant. */
  setCapabilityConfiguration(
    request: C.CapabilityConfiguration,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.CapabilityConfiguration>>;
  getCapabilityLocks(
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.CapabilityLocks>>;
  setCapabilityLocks(
    request: C.CapabilityLocks,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.CapabilityLocks>>;
  getCapabilities(
    conversationId: string,
    options?: C.RequestOptions,
  ): Promise<C.CapabilityCheck>;
  /** Checks the target category (or uncategorized workspace) before creation. */
  getChannelCreationCheck(
    scope: C.ChannelCreationScope,
    options?: C.RequestOptions,
  ): Promise<C.ChannelCreationCheck>;
  /** manageChannel required to inspect someone else. Sources describe committed state. */
  checkPerson(
    conversationId: string,
    userId: string,
    options?: C.RequestOptions,
  ): Promise<C.CapabilityCheck>;
  // Composed from the same workspace settings resource, not duplicate endpoints.
  getDirectPolicy(
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.DirectPolicy>>;
  setDirectPolicy(
    request: C.DirectPolicy,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.DirectPolicy>>;

  getPresence(
    request: C.PresenceListRequest,
    options?: C.RequestOptions,
  ): Promise<C.PresenceSnapshot>;
  heartbeatPresence(
    request: C.PresenceRequest,
    options?: C.RequestOptions,
  ): Promise<void>;
  sendTyping(conversationId: string, options?: C.RequestOptions): Promise<void>;
  search(
    request: C.SearchRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.SearchHit>>;

  reportMessage(
    conversationId: string,
    messageId: string,
    request: C.ReportRequest,
    options?: C.RequestOptions,
  ): Promise<void>;
  listReports(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Report>>;
  getReport(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Report>>;
  resolveReport(id: string, options: C.ConditionalOptions): Promise<C.Report>;
  removeMessage(
    conversationId: string,
    messageId: string,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Tombstone>>;
  restoreMessage(
    conversationId: string,
    messageId: string,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.LiveMessage>>;
  listRemovedMessages(
    conversationId: string,
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Tombstone>>;
  setPostingRestrictions(
    conversationId: string,
    request: C.RestrictionRequest,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.SettingsResponse>>;

  listSchedules(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Schedule>>;
  getSchedule(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Schedule>>;
  createSchedule(
    request: C.ScheduleRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Schedule>>;
  updateSchedule(
    id: string,
    request: C.ScheduleRequest,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Schedule>>;
  sendScheduleNow(
    id: string,
    options: C.ConditionalOptions,
  ): Promise<C.Schedule>;
  cancelSchedule(
    id: string,
    options: C.ConditionalOptions,
  ): Promise<C.Schedule>;
  getRetention(
    scope: C.RetentionPolicy["scope"],
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.RetentionResponse>>;
  previewRetention(
    request: C.RetentionPolicy,
    options: C.ConditionalOptions & C.FreshAdminOptions,
  ): Promise<C.RetentionPreview>;
  /** A channel null resets that period to inheritance through this same command. */
  updateRetention(
    request: C.RetentionRequest,
    options: C.ConditionalOptions & C.FreshAdminOptions,
  ): Promise<C.Versioned<C.RetentionResponse>>;
  previewPurge(
    conversationId: string,
    options?: C.RequestOptions,
  ): Promise<C.PurgePreview>;
  purgeConversation(
    conversationId: string,
    request: C.PurgeRequest,
    options?: C.RequestOptions,
  ): Promise<C.PurgeResult>;
  listExports(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.ExportJob>>;
  startExport(
    request: C.ExportRequest,
    options?: C.RequestOptions | C.FreshAdminOptions,
  ): Promise<C.ExportJob>;
  getExport(id: string, options?: C.RequestOptions): Promise<C.ExportJob>;
  downloadExport(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.BinaryDownload>;
  listTemplates(
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.Template>>;
  getTemplate(
    id: string,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Template>>;
  previewTemplateApply(
    id: string,
    request: C.TemplateApplyRequest,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.TemplateApplyPreview>>;
  saveTemplate(
    id: string,
    request: C.TemplateImport,
    options: C.ConditionalOptions,
  ): Promise<C.Versioned<C.Template>>;
  createTemplate(
    request: C.TemplateImport,
    options?: C.RequestOptions,
  ): Promise<C.Versioned<C.Template>>;
  applyTemplate(
    id: string,
    request: C.TemplateApplyRequest,
    options: C.ConditionalOptions,
  ): Promise<C.TemplateApplyResult>;
  listConfigurationHistory(
    scope: C.SettingsScope,
    request?: C.TimeListRequest,
    options?: C.RequestOptions,
  ): Promise<C.Page<C.ConfigurationHistory>>;
  getConfigurationHistory(
    scope: C.SettingsScope,
    historyId: string,
    options?: C.RequestOptions,
  ): Promise<C.ConfigurationHistory>;
  previewConfigurationRestore(
    scope: C.SettingsScope,
    historyId: string,
    options: C.ConditionalOptions & C.FreshAdminOptions,
  ): Promise<C.Versioned<C.ConfigurationRestorePreview>>;
  restoreConfiguration(
    scope: C.SettingsScope,
    request: C.ConfigurationRestoreRequest,
    options: C.ConditionalOptions & C.FreshAdminOptions,
  ): Promise<C.Versioned<C.ConfigurationSnapshot>>;
}

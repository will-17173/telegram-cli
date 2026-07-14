const group = {
  id: 42,
  title: 'General',
  username: null,
  type: 'supergroup',
  member_count: 1,
  current_user_role: 'creator',
  current_user_rank: null,
  permissions: null,
  default_restrictions: null,
  slow_mode_seconds: null,
  message_ttl_seconds: null,
  content_protected: false,
  forum: false,
}

export function createTelegramClient() {
  return {
    groups: {
      getGroup: async () => group,
      transferOwnership: async request => ({
        operation: 'transferOwnership',
        chat_id: 42,
        target_id: request.user,
      }),
    },
    close: async () => undefined,
  }
}

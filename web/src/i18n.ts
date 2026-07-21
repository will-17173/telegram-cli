export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'tg-web:locale'

type FormatValue = string | number | boolean | null | undefined

export type WebMessages = {
  common: {
    add: string
    cancel: string
    close: string
    delete: string
    deleting: string
    disabled: string
    enabled: string
    go: string
    loading: string
    refresh: string
    remove: string
    reset: string
    saveRule: string
    saving: string
    search: string
    syncing: string
    unknown: string
    updating: string
  }
  shell: {
    account: string
    guard: string
    guardConsole: string
    language: string
    localMessageConsole: string
    messages: string
    syncStatus: string
    workspaceView: string
  }
  messages: {
    allHiddenByBlacklist: string
    blacklistCount: string
    chatId: string
    chats: string
    closeSenderBlacklist: string
    download: string
    downloadAll: string
    downloaded: string
    downloadedTo: string
    downloading: string
    files: string
    filterBySender: string
    filterBySenderAria: string
    filters: string
    first: string
    groupedId: string
    hiddenCountSuffix: string
    hideSender: string
    hideSenderAria: string
    id: string
    jumpTo: string
    last: string
    message: string
    messageFallback: string
    messageFilters: string
    messageNotFound: string
    messagePage: string
    messagePages: string
    messageStream: string
    messageVisibility: string
    messages: string
    messagesFromTo: string
    messagesShown: string
    nameMatch: string
    noChatSelected: string
    noLocalChats: string
    noMatchingMessages: string
    noSendersHidden: string
    noText: string
    notDownloaded: string
    next: string
    pageNumbers: string
    pageSize: string
    partialDownloaded: string
    previous: string
    readingLocalCache: string
    searchChats: string
    selectChat: string
    senderBlacklist: string
    senderId: string
    senderName: string
    syncCurrentChat: string
    syncFailed: string
    text: string
    until: string
    since: string
  }
  guard: {
    action: string
    activityLabel: string
    activity: string
    addRule: string
    adminsIncluded: string
    adminsSkipped: string
    ban: string
    banAllowed: string
    banBlocked: string
    blockInviteLinks: string
    blockUrls: string
    closeRuleEditor: string
    command: string
    cooldown: string
    deleteAllowed: string
    deleteBlocked: string
    flood: string
    groupAutomation: string
    groupPolicy: string
    groupPolicyLimits: string
    groups: string
    groupsLabel: string
    groupsEnabled: string
    enabledForAutomation: string
    inviteLink: string
    invites: string
    joinedSeconds: string
    links: string
    listening: string
    managedGroups: string
    matchRegex: string
    matchText: string
    maxMessages: string
    memberAge: string
    message: string
    messageRate: string
    mute: string
    muteAllowed: string
    muteBlocked: string
    muteSeconds: string
    name: string
    newMember: string
    newRule: string
    noAction: string
    noActivity: string
    noManagedGroups: string
    noRules: string
    noTrigger: string
    pattern: string
    pendingActions: string
    policyLimits: string
    policyNote: string
    postNotice: string
    priority: string
    queue: string
    rateLimit: string
    reason: string
    recentActions: string
    recentRecords: string
    recentRecordsCount: string
    record: string
    recordOnly: string
    refresh: string
    repeatedMessage: string
    reply: string
    rule: string
    ruleMatched: string
    ruleSummary: string
    ruleTemplates: string
    rules: string
    rulesEnabled: string
    rulesOff: string
    rulesOn: string
    rulesOffDetail: string
    rulesListeningDetail: string
    rulesStartingDetail: string
    rulesPausedDetail: string
    rulesErrorDetail: string
    rulesRestartDetail: string
    runtime: string
    runtimeDescription: string
    saveRule: string
    seconds: string
    selectGroup: string
    selectedGroupRulesAndPolicy: string
    started: string
    notStarted: string
    starting: string
    statusError: string
    statusPaused: string
    statusRestartNeeded: string
    statusStarting: string
    syncGroups: string
    textContains: string
    then: string
    trigger: string
    url: string
    warn: string
    when: string
  }
}

export const messages: Record<Locale, WebMessages> = {
  en: {
    common: {
      add: 'Add',
      cancel: 'Cancel',
      close: 'Close',
      delete: 'Delete',
      deleting: 'Deleting',
      disabled: 'Disabled',
      enabled: 'Enabled',
      go: 'Go',
      loading: 'Loading',
      refresh: 'Refresh',
      remove: 'Remove',
      reset: 'Reset',
      saveRule: 'Save rule',
      saving: 'Saving...',
      search: 'Search',
      syncing: 'Syncing',
      unknown: 'Unknown',
      updating: 'Updating',
    },
    shell: {
      account: 'Account',
      guard: 'Guard',
      guardConsole: 'Guard console',
      language: 'Language',
      localMessageConsole: 'Local message console',
      messages: 'Messages',
      syncStatus: 'Sync {status}',
      workspaceView: 'Workspace view',
    },
    messages: {
      allHiddenByBlacklist: 'All messages on this page are hidden by blacklist.',
      blacklistCount: 'Blacklist {count}',
      chatId: 'Chat ID {id}',
      chats: 'Chats',
      closeSenderBlacklist: 'Close sender blacklist',
      download: 'Download',
      downloadAll: 'Download all',
      downloaded: 'Downloaded',
      downloadedTo: 'Downloaded to {destination}',
      downloading: 'Downloading',
      files: '{count} files',
      filterBySender: 'Filter messages by this sender',
      filterBySenderAria: 'Filter messages by {sender} in this chat',
      filters: 'Filters',
      first: 'First',
      groupedId: 'Grouped ID {id}',
      hiddenCountSuffix: ', {count} hidden',
      hideSender: 'Hide messages from this sender',
      hideSenderAria: 'Hide messages from {sender} in this chat',
      id: 'ID {id}',
      jumpTo: 'Jump to',
      last: 'Last',
      message: 'Message {id}',
      messageFallback: 'message',
      messageFilters: 'Message filters',
      messageNotFound: 'Message not found in the local cache.',
      messagePage: 'Jump to message page',
      messagePages: 'Messages {ids}',
      messageStream: 'Message stream',
      messageVisibility: 'Message visibility',
      messages: '{count} messages',
      messagesFromTo: '{count} messages from {first} to {last}',
      messagesShown: '{visible} of {total} shown',
      nameMatch: 'Name match',
      noChatSelected: 'No chat selected',
      noLocalChats: 'No local chats found.',
      noMatchingMessages: 'No messages match the current filters.',
      noSendersHidden: 'No senders are hidden in this chat.',
      noText: '(no text)',
      notDownloaded: 'Not downloaded',
      next: 'Next',
      pageNumbers: 'Page numbers',
      pageSize: 'Page size',
      partialDownloaded: 'Partially downloaded',
      previous: 'Previous',
      readingLocalCache: 'Reading local cache',
      searchChats: 'Search chats',
      selectChat: 'Select a chat',
      senderBlacklist: 'Sender blacklist',
      senderId: 'Sender ID',
      senderName: 'Sender name',
      syncCurrentChat: 'Sync current chat',
      syncFailed: 'Sync failed ({code}): {message}',
      text: 'Text',
      until: 'Until',
      since: 'Since',
    },
    guard: {
      action: 'Action',
      activity: 'Activity',
      activityLabel: 'Activity',
      addRule: 'Add rule',
      adminsIncluded: 'Admins included',
      adminsSkipped: 'Admins skipped',
      ban: 'Ban',
      banAllowed: 'Ban allowed',
      banBlocked: 'Ban blocked',
      blockInviteLinks: 'Block invite links',
      blockUrls: 'Block URLs',
      closeRuleEditor: 'Close rule editor',
      command: 'Command',
      cooldown: '{seconds}s cooldown',
      deleteAllowed: 'Delete allowed',
      deleteBlocked: 'Delete blocked',
      flood: 'Flood',
      groupAutomation: 'Group automation',
      groupPolicy: 'Group policy',
      groupPolicyLimits: 'Group policy limits',
      groups: '{count} groups',
      groupsLabel: 'Groups',
      groupsEnabled: '{enabled} enabled',
      enabledForAutomation: 'Enabled for automation',
      inviteLink: 'Invite link',
      invites: 'Invites',
      joinedSeconds: 'Joined < {seconds}s',
      links: 'Links',
      listening: 'Listening',
      managedGroups: 'Managed groups',
      matchRegex: 'Match regex',
      matchText: 'Match text',
      maxMessages: 'Max messages',
      memberAge: 'Member age',
      message: 'Message',
      messageRate: 'Message rate',
      mute: 'Mute',
      muteAllowed: 'Mute allowed',
      muteBlocked: 'Mute blocked',
      muteSeconds: 'Mute seconds',
      name: 'Name',
      newMember: 'New member',
      newRule: 'New rule',
      noAction: 'No action',
      noActivity: 'No guard activity recorded yet.',
      noManagedGroups: 'No managed groups found.',
      noRules: 'No rules configured for this group.',
      noTrigger: 'No trigger',
      pattern: 'Pattern',
      pendingActions: 'Pending actions',
      policyLimits: 'Policy limits',
      policyNote: 'These limits only apply after an enabled rule matches.',
      postNotice: 'Post notice',
      priority: 'Priority',
      queue: 'Queue',
      rateLimit: 'Rate limit',
      reason: 'Reason',
      recentActions: 'Recent actions',
      recentRecords: 'Recent action records',
      recentRecordsCount: '{count} records',
      record: 'Record',
      recordOnly: 'Record only',
      refresh: 'Refresh',
      repeatedMessage: 'Repeated message',
      reply: 'Reply',
      rule: 'Rule',
      ruleMatched: 'Rule matched',
      ruleSummary: '{condition} -> {action} · Priority {priority}',
      ruleTemplates: 'Rule templates',
      rules: 'Rules',
      rulesEnabled: '{enabled}/{total} enabled',
      rulesOff: 'Rules off',
      rulesOn: 'Rules on',
      rulesOffDetail: 'Rules are off for this group.',
      rulesListeningDetail: 'Rules are on and Guard is listening.',
      rulesStartingDetail: 'Rules are on and Guard is starting.',
      rulesPausedDetail: 'Rules are on but Guard is paused.',
      rulesErrorDetail: 'Rules are on but the listener reported an error.',
      rulesRestartDetail: 'Rules are on. Restart tg guard start to begin listening.',
      runtime: 'Runtime',
      runtimeDescription: 'Local rules, group policy, and moderation activity from the guard database.',
      saveRule: 'Save rule',
      seconds: 'Seconds',
      selectGroup: 'Select a group',
      selectedGroupRulesAndPolicy: 'Selected group rules and policy',
      started: 'Started {date}',
      notStarted: 'Not started',
      starting: 'Starting',
      statusError: 'Error',
      statusPaused: 'Paused',
      statusRestartNeeded: 'Restart needed',
      statusStarting: 'Starting',
      syncGroups: 'Sync groups',
      textContains: 'Text contains',
      then: 'Then',
      trigger: 'Trigger',
      url: 'URL',
      warn: 'Warn',
      when: 'When',
    },
  },
  'zh-CN': {
    common: {
      add: '添加',
      cancel: '取消',
      close: '关闭',
      delete: '删除',
      deleting: '删除中',
      disabled: '已停用',
      enabled: '已启用',
      go: '跳转',
      loading: '加载中',
      refresh: '刷新',
      remove: '移除',
      reset: '重置',
      saveRule: '保存规则',
      saving: '保存中...',
      search: '搜索',
      syncing: '同步中',
      unknown: '未知',
      updating: '更新中',
    },
    shell: {
      account: '账号',
      guard: '守卫',
      guardConsole: '守卫控制台',
      language: '语言',
      localMessageConsole: '本地消息控制台',
      messages: '消息',
      syncStatus: '同步 {status}',
      workspaceView: '工作区视图',
    },
    messages: {
      allHiddenByBlacklist: '此页全部消息已被黑名单隐藏。',
      blacklistCount: '黑名单 {count}',
      chatId: '聊天 ID {id}',
      chats: '聊天',
      closeSenderBlacklist: '关闭发送者黑名单',
      download: '下载',
      downloadAll: '全部下载',
      downloaded: '已下载',
      downloadedTo: '已下载到 {destination}',
      downloading: '下载中',
      files: '{count} 个文件',
      filterBySender: '按此发送者筛选消息',
      filterBySenderAria: '在此聊天中按 {sender} 筛选消息',
      filters: '筛选',
      first: '首页',
      groupedId: '分组 ID {id}',
      hiddenCountSuffix: '，隐藏 {count} 条',
      hideSender: '隐藏此发送者的消息',
      hideSenderAria: '在此聊天中隐藏 {sender} 的消息',
      id: 'ID {id}',
      jumpTo: '跳转到',
      last: '末页',
      message: '消息 {id}',
      messageFallback: '消息',
      messageFilters: '消息筛选',
      messageNotFound: '本地缓存中未找到该消息。',
      messagePage: '跳转到消息页',
      messagePages: '消息 {ids}',
      messageStream: '消息流',
      messageVisibility: '消息可见性',
      messages: '{count} 条消息',
      messagesFromTo: '{count} 条消息，从 {first} 到 {last}',
      messagesShown: '显示 {visible} / {total}',
      nameMatch: '按名称匹配',
      noChatSelected: '未选择聊天',
      noLocalChats: '未找到本地聊天。',
      noMatchingMessages: '没有消息匹配当前筛选条件。',
      noSendersHidden: '此聊天中没有隐藏的发送者。',
      noText: '（无文本）',
      notDownloaded: '未下载',
      next: '下一页',
      pageNumbers: '页码',
      pageSize: '每页数量',
      partialDownloaded: '部分已下载',
      previous: '上一页',
      readingLocalCache: '正在读取本地缓存',
      searchChats: '搜索聊天',
      selectChat: '选择聊天',
      senderBlacklist: '发送者黑名单',
      senderId: '发送者 ID',
      senderName: '发送者名称',
      syncCurrentChat: '同步当前聊天',
      syncFailed: '同步失败（{code}）：{message}',
      text: '文本',
      until: '结束',
      since: '开始',
    },
    guard: {
      action: '动作',
      activity: '活动',
      activityLabel: '活动',
      addRule: '添加规则',
      adminsIncluded: '包含管理员',
      adminsSkipped: '跳过管理员',
      ban: '封禁',
      banAllowed: '允许封禁',
      banBlocked: '禁止封禁',
      blockInviteLinks: '拦截邀请链接',
      blockUrls: '拦截 URL',
      closeRuleEditor: '关闭规则编辑器',
      command: '命令',
      cooldown: '{seconds} 秒冷却',
      deleteAllowed: '允许删除',
      deleteBlocked: '禁止删除',
      flood: '刷屏',
      groupAutomation: '群组自动化',
      groupPolicy: '群组策略',
      groupPolicyLimits: '群组策略限制',
      groups: '{count} 个群组',
      groupsLabel: '群组',
      groupsEnabled: '已启用 {enabled} 个',
      enabledForAutomation: '已启用自动化',
      inviteLink: '邀请链接',
      invites: '邀请',
      joinedSeconds: '入群 < {seconds} 秒',
      links: '链接',
      listening: '监听中',
      managedGroups: '托管群组',
      matchRegex: '匹配正则',
      matchText: '匹配文本',
      maxMessages: '最大消息数',
      memberAge: '成员时长',
      message: '消息',
      messageRate: '消息频率',
      mute: '禁言',
      muteAllowed: '允许禁言',
      muteBlocked: '禁止禁言',
      muteSeconds: '禁言秒数',
      name: '名称',
      newMember: '新成员',
      newRule: '新规则',
      noAction: '无动作',
      noActivity: '暂无守卫活动记录。',
      noManagedGroups: '未找到托管群组。',
      noRules: '此群组尚未配置规则。',
      noTrigger: '无触发条件',
      pattern: '模式',
      pendingActions: '待处理动作',
      policyLimits: '策略限制',
      policyNote: '这些限制只会在已启用规则命中后生效。',
      postNotice: '发送通知',
      priority: '优先级',
      queue: '队列',
      rateLimit: '频率限制',
      reason: '原因',
      recentActions: '最近动作',
      recentRecords: '最近动作记录',
      recentRecordsCount: '{count} 条记录',
      record: '记录',
      recordOnly: '仅记录',
      refresh: '刷新',
      repeatedMessage: '重复消息',
      reply: '回复',
      rule: '规则',
      ruleMatched: '规则已命中',
      ruleSummary: '{condition} -> {action} · 优先级 {priority}',
      ruleTemplates: '规则模板',
      rules: '规则',
      rulesEnabled: '已启用 {enabled}/{total}',
      rulesOff: '规则关闭',
      rulesOn: '规则开启',
      rulesOffDetail: '此群组的规则已关闭。',
      rulesListeningDetail: '规则已开启，守卫正在监听。',
      rulesStartingDetail: '规则已开启，守卫正在启动。',
      rulesPausedDetail: '规则已开启，但守卫已暂停。',
      rulesErrorDetail: '规则已开启，但监听器报告了错误。',
      rulesRestartDetail: '规则已开启。请重启 tg guard start 开始监听。',
      runtime: '运行状态',
      runtimeDescription: '来自守卫数据库的本地规则、群组策略和审核活动。',
      saveRule: '保存规则',
      seconds: '秒',
      selectGroup: '选择群组',
      selectedGroupRulesAndPolicy: '所选群组的规则和策略',
      started: '启动于 {date}',
      notStarted: '未启动',
      starting: '启动中',
      statusError: '错误',
      statusPaused: '已暂停',
      statusRestartNeeded: '需要重启',
      statusStarting: '启动中',
      syncGroups: '同步群组',
      textContains: '文本包含',
      then: '则执行',
      trigger: '触发条件',
      url: 'URL',
      warn: '警告',
      when: '当',
    },
  },
}

export type InitialLocaleInput = {
  search?: string
  storedLocale?: string | null
  navigatorLanguages?: readonly string[] | null
}

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase().replace('_', '-')
  if (normalized === '') return null
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return null
}

export function resolveInitialLocale(input: InitialLocaleInput = {}): Locale {
  const urlLocale = localeFromSearch(input.search)
  if (urlLocale != null) return urlLocale

  const stored = normalizeLocale(input.storedLocale)
  if (stored != null) return stored

  for (const language of input.navigatorLanguages ?? []) {
    const normalized = normalizeLocale(language)
    if (normalized != null) return normalized
  }

  return DEFAULT_LOCALE
}

export function getStoredLocale(storage: Pick<Storage, 'getItem'> | null | undefined): string | null {
  if (storage == null) return null
  try {
    return storage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeLocale(storage: Pick<Storage, 'setItem'> | null | undefined, locale: Locale): void {
  if (storage == null) return
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Locale persistence is best-effort; rendering should never depend on it.
  }
}

export function setUrlLocale(url: string, locale: Locale): string {
  const next = new URL(url)
  next.searchParams.set('lang', locale)
  return next.toString()
}

export function replaceUrlLocale(location: Location | null | undefined, history: Pick<History, 'replaceState'> | null | undefined, locale: Locale): void {
  if (location == null || history == null) return
  try {
    history.replaceState(null, '', setUrlLocale(location.href, locale))
  } catch {
    // URL synchronization is best-effort.
  }
}

export function formatMessage(template: string, values: Record<string, FormatValue>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = values[key]
    return value == null ? '' : String(value)
  })
}

export function formatDateForLocale(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function localeFromSearch(search: string | undefined): Locale | null {
  if (search == null || search === '') return null
  try {
    return normalizeLocale(new URLSearchParams(search).get('lang'))
  } catch {
    return null
  }
}

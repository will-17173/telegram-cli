import type { DesktopCategory, DesktopCommand, DesktopField, DesktopTask } from '../../src/web/workspace-types.js'
import type { Locale } from './i18n.js'

const en = {
  operations: 'Operations', searchOperations: 'Search operations', all: 'All operations',
  noOperations: 'No operations match your search.', loadingOperations: 'Loading operations…',
  chooseOperation: 'Choose an operation', chooseOperationHint: 'Select an operation to see its inputs and run it.',
  parameters: 'Parameters', advanced: 'Advanced options', noParameters: 'This operation needs no additional inputs.',
  required: 'Required', optional: 'Optional', addValue: 'Add value', removeValue: 'Remove value',
  multipleHint: 'Each row is one value. Line breaks inside a row are preserved.',
  requiredError: 'Enter a value for this field.', invalidChoice: 'Choose one of the listed values.',
  problem: 'Check these fields', run: 'Run operation', starting: 'Starting…', reset: 'Reset inputs',
  account: 'Account', allAccounts: 'All accounts', noAccount: 'Choose or add an account before running this operation.',
  globalOperation: 'Applies to local settings', longRunning: 'Runs until finished or cancelled',
  review: 'Review this action', destructiveHint: 'This action changes or deletes data. Check the account and target before continuing.',
  confirm: 'I reviewed the target and want to run this action.', confirmError: 'Confirm this action before running it.',
  exactTitleHint: 'Enter the exact current group title to confirm deletion.',
  history: 'Task history', noHistory: 'Completed and running operations appear here.',
  result: 'Result', noResult: 'Run an operation or select a task to inspect its result.',
  liveOutput: 'Live output', stdout: 'Output', stderr: 'Diagnostics', noOutput: 'No output yet.',
  stop: 'Cancel task', stopping: 'Cancelling…', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  started: 'Started', finished: 'Finished', exitCode: 'Exit code', refresh: 'Refresh', retry: 'Try again',
  copy: 'Copy JSON', copied: 'Copied', json: 'Download JSON', yaml: 'Download YAML', markdown: 'Download Markdown',
  saveJson: 'Save JSON', saveYaml: 'Save YAML', saveMarkdown: 'Save Markdown', savingResult: 'Saving result…', resultSavedTo: 'Saved to {path}',
  raw: 'Raw result', empty: 'No data returned.', rows: 'rows', limited: 'Showing the first {count} items. Download the result for all data.',
  truncated: 'Older output was trimmed. The latest output is shown.', chooseFile: 'Choose file', chooseFiles: 'Choose files',
  chooseDirectory: 'Choose folder', chooseSave: 'Choose destination', manualPath: 'Enter a path on this computer.', reveal: 'Show in folder',
  accounts: 'Accounts', addAccount: 'Add account', noAccounts: 'Connect your first Telegram account',
  noAccountsHint: 'Sign in with your phone number, the Telegram code, and your two-step password if enabled.',
  accountHint: 'Your account sessions and local data are shared with the Telegram CLI.',
  current: 'Default', selected: 'Selected', signedIn: 'Signed in', loggedOut: 'Logged out',
  select: 'Use account', switchDefault: 'Make default', signIn: 'Sign in', logout: 'Log out', removeAccount: 'Remove account', rename: 'Rename',
  removeAccountHint: 'Remove this account and its local session, cached messages, and files.',
  logoutHint: 'End this Telegram session. You can sign in again later.',
  exactAccount: 'Type the account name to confirm', accountName: 'Account name', newName: 'New account name',
  cancel: 'Cancel', connect: 'Connect account', phone: 'Phone number', phoneHint: 'Include the country code, for example +1 555 123 4567.',
  code: 'Telegram code', codeHint: 'Enter the code sent by Telegram. You can paste it here.',
  password: 'Two-step password', passwordHint: 'Enter your Telegram two-step verification password.',
  continue: 'Continue', submitCode: 'Verify code', submitPassword: 'Verify password', authenticating: 'Connecting to Telegram…',
  authentication: 'Connect Telegram', authDone: 'Account connected', authError: 'Could not connect this account',
  authCancelled: 'Sign-in cancelled', tryLoginAgain: 'Start sign-in again', configure: 'Configure API and proxy',
  configurationHint: 'Set your Telegram API credentials and optional proxy in Settings.', secretHint: 'This value is hidden and cleared after it is sent.',
  actionInProgress: 'An account action is running.', authInProgress: 'Finish or cancel the current sign-in to start another.',
  enabled: 'Enabled', disabled: 'Disabled', value: 'Value',
  compose: 'Send while listening', composeHint: 'Send through this listener’s account while incoming messages continue.',
  sendMessage: 'Send message', sendingMessage: 'Sending…', messageSent: 'Message sent',
  composeOptions: 'Reply and attachments', messageOrFile: 'Enter a message or add an attachment.',
  invalidReply: 'Enter a positive message ID.',
}

type WorkspaceMessages = { [K in keyof typeof en]: string }

const zh: WorkspaceMessages = {
  operations: '操作', searchOperations: '搜索操作', all: '全部操作',
  noOperations: '没有匹配的操作。', loadingOperations: '正在加载操作…',
  chooseOperation: '选择操作', chooseOperationHint: '选择一项操作，填写参数后运行。',
  parameters: '参数', advanced: '高级选项', noParameters: '此操作无需额外参数。',
  required: '必填', optional: '可选', addValue: '添加一项', removeValue: '移除此项',
  multipleHint: '每行输入框对应一个值，框内的换行会保留。',
  requiredError: '请填写此项。', invalidChoice: '请选择列表中的值。',
  problem: '请检查以下字段', run: '运行操作', starting: '正在启动…', reset: '重置参数',
  account: '账号', allAccounts: '全部账号', noAccount: '请先选择或添加账号，再运行此操作。',
  globalOperation: '作用于本地设置', longRunning: '运行至完成或手动取消',
  review: '确认操作', destructiveHint: '此操作会修改或删除数据，请先核对账号和操作目标。',
  confirm: '已核对目标，确认执行此操作。', confirmError: '请先确认此操作。',
  exactTitleHint: '请输入群组当前的完整名称以确认删除。',
  history: '任务历史', noHistory: '运行中和已完成的操作会显示在此处。',
  result: '结果', noResult: '运行一项操作，或选择历史任务查看结果。',
  liveOutput: '实时输出', stdout: '输出', stderr: '诊断信息', noOutput: '暂无输出。',
  stop: '取消任务', stopping: '正在取消…', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
  started: '开始时间', finished: '完成时间', exitCode: '退出码', refresh: '刷新', retry: '重试',
  copy: '复制 JSON', copied: '已复制', json: '下载 JSON', yaml: '下载 YAML', markdown: '下载 Markdown',
  saveJson: '保存 JSON', saveYaml: '保存 YAML', saveMarkdown: '保存 Markdown', savingResult: '正在保存结果…', resultSavedTo: '已保存到 {path}',
  raw: '原始结果', empty: '未返回数据。', rows: '行', limited: '显示前 {count} 项，下载结果可查看完整数据。',
  truncated: '早期输出已截断，此处显示最新输出。', chooseFile: '选择文件', chooseFiles: '选择多个文件',
  chooseDirectory: '选择文件夹', chooseSave: '选择保存位置', manualPath: '请输入此电脑上的路径。', reveal: '在文件夹中显示',
  accounts: '账号', addAccount: '添加账号', noAccounts: '连接第一个 Telegram 账号',
  noAccountsHint: '使用手机号、Telegram 验证码，以及已开启的两步验证密码登录。',
  accountHint: '账号会话和本地数据与 Telegram CLI 共用。',
  current: '默认账号', selected: '当前所选', signedIn: '已登录', loggedOut: '已退出',
  select: '使用账号', switchDefault: '设为默认', signIn: '登录', logout: '退出登录', removeAccount: '移除账号', rename: '重命名',
  removeAccountHint: '移除此账号及其本地会话、缓存消息和文件。',
  logoutHint: '结束此 Telegram 会话，之后可重新登录。',
  exactAccount: '输入账号名称以确认', accountName: '账号名称', newName: '新的账号名称',
  cancel: '取消', connect: '连接账号', phone: '手机号码', phoneHint: '包含国家区号，例如 +86 138 0013 8000。',
  code: 'Telegram 验证码', codeHint: '输入 Telegram 发送的验证码，可直接粘贴。',
  password: '两步验证密码', passwordHint: '输入 Telegram 两步验证密码。',
  continue: '继续', submitCode: '验证验证码', submitPassword: '验证密码', authenticating: '正在连接 Telegram…',
  authentication: '连接 Telegram', authDone: '账号已连接', authError: '无法连接此账号',
  authCancelled: '登录已取消', tryLoginAgain: '重新登录', configure: '配置 API 与代理',
  configurationHint: '在设置中填写 Telegram API 凭据和可选代理。', secretHint: '此内容已隐藏，提交后会清空。',
  actionInProgress: '账号操作正在运行。', authInProgress: '请先完成或取消当前登录，再开始新的登录。',
  enabled: '启用', disabled: '停用', value: '值',
  compose: '监听时发送消息', composeHint: '使用此监听任务的账号发送消息，同时继续接收新消息。',
  sendMessage: '发送消息', sendingMessage: '正在发送…', messageSent: '消息已发送',
  composeOptions: '回复与附件', messageOrFile: '请输入消息或添加附件。',
  invalidReply: '请输入大于 0 的消息 ID。',
}

export const workspaceMessages: Record<Locale, WorkspaceMessages> = { en, 'zh-CN': zh }

export const categoryLabels: Record<Locale, Record<DesktopCategory, string>> = {
  en: { telegram: 'Telegram', messages: 'Local messages', groups: 'Groups', contacts: 'Contacts', folders: 'Folders', notifications: 'Notifications', accounts: 'Accounts', settings: 'Settings', data: 'Data & files' },
  'zh-CN': { telegram: 'Telegram', messages: '本地消息', groups: '群组', contacts: '联系人', folders: '聊天文件夹', notifications: '通知', accounts: '账号', settings: '设置', data: '数据与文件' },
}

const commandWords: Record<string, [string, string]> = {
  status: ['Connection status', '连接状态'], whoami: ['My profile', '我的资料'], chats: ['Chats', '聊天列表'],
  history: ['Backfill history', '补齐历史消息'], sync: ['Sync messages', '同步消息'], repair: ['Repair message gaps', '修复消息缺口'],
  'sync-all': ['Sync all chats', '同步全部聊天'], refresh: ['Refresh all chats', '刷新全部聊天'], info: ['Details', '详情'],
  send: ['Send message', '发送消息'], edit: ['Edit', '编辑'], delete: ['Delete', '删除'], download: ['Download attachments', '下载附件'],
  listen: ['Listen for messages', '监听消息'], search: ['Search', '搜索'], recent: ['Recent messages', '最近消息'],
  stats: ['Statistics', '统计'], top: ['Top senders', '活跃发送者'], timeline: ['Timeline', '时间线'], today: ['Today’s messages', '今日消息'],
  filter: ['Filter messages', '筛选消息'], inbox: ['Unread chats', '未读聊天'], read: ['Read messages', '读取消息'],
  'search-online': ['Search Telegram', '搜索 Telegram'], dialog: ['Dialogs', '会话'], group: ['Group', '群组'], groups: ['Groups', '群组列表'],
  contact: ['Contact', '联系人'], notification: ['Notification', '通知'], folder: ['Folder', '文件夹'], account: ['Account', '账号'],
  data: ['Local data', '本地数据'], config: ['Settings', '设置'], archive: ['Archive chats', '归档聊天'], export: ['Export messages', '导出消息'],
  purge: ['Purge messages', '清除消息'], reset: ['Reset', '重置'], set: ['Configure', '配置'], list: ['List', '列表'],
  'write-access': ['Write access', '写入权限'], current: ['Current', '当前账号'], switch: ['Set default', '设为默认'],
  rename: ['Rename', '重命名'], remove: ['Remove', '移除'], logout: ['Log out', '退出登录'], login: ['Sign in', '登录'],
  add: ['Add', '添加'], preset: ['Preset', '预设'], presets: ['Presets', '预设'],
  member: ['Member', '成员'], members: ['Members', '成员列表'], audit: ['Audit log', '管理日志'], admin: ['Administrator', '管理员'],
  kick: ['Kick', '移出'], ban: ['Ban', '封禁'], unban: ['Unban', '解除封禁'], mute: ['Mute', '禁言'], unmute: ['Unmute', '解除禁言'],
  promote: ['Promote', '授予管理权限'], demote: ['Demote', '撤销管理权限'], rank: ['Custom title', '自定义头衔'],
  'transfer-owner': ['Transfer ownership', '转让所有权'], chat: ['Chat settings', '聊天设置'], title: ['Title', '名称'],
  description: ['Description', '简介'], username: ['Username', '用户名'], photo: ['Photo', '头像'], slowmode: ['Slow mode', '慢速模式'],
  ttl: ['Auto-delete timer', '自动删除时限'], protect: ['Content protection', '内容保护'], 'join-requests': ['Join approval', '入群审批'],
  'join-to-send': ['Require membership to post', '加入后才能发言'], 'default-permissions': ['Default permissions', '默认权限'],
  'sticker-set': ['Sticker set', '贴纸包'], leave: ['Leave', '退出'], invite: ['Invite link', '邀请链接'], show: ['Details', '详情'],
  create: ['Create', '创建'], revoke: ['Revoke', '撤销'], approve: ['Approve', '批准'], decline: ['Decline', '拒绝'],
  'approve-all': ['Approve all', '批准全部'], 'decline-all': ['Decline all', '拒绝全部'], topic: ['Topic', '话题'],
  close: ['Close', '关闭'], reopen: ['Reopen', '重新打开'], pin: ['Pin', '置顶'], unpin: ['Unpin', '取消置顶'],
  reorder: ['Reorder', '调整顺序'], 'general-hidden': ['General topic visibility', '默认话题可见性'], message: ['Message', '消息'],
  'unpin-all': ['Unpin all', '取消全部置顶'],
}

const fieldWords: Record<string, [string, string]> = {
  chat: ['Chat', '聊天'], chats: ['Chats', '聊天'], message: ['Message', '消息正文'], text: ['Text', '文本'],
  user: ['User', '用户'], users: ['Users', '用户'], userOrPhone: ['User or phone number', '用户或手机号'],
  contextUser: ['Context user', '上下文用户'], keyword: ['Keyword', '关键词'], keywords: ['Keywords', '关键词'], query: ['Search query', '搜索词'],
  msgId: ['Message ID', '消息 ID'], msgIds: ['Message IDs', '消息 ID'], id: ['ID', 'ID'], ids: ['IDs', 'ID'],
  name: ['Account name', '账号名称'], newName: ['New name', '新名称'], folder: ['Folder', '文件夹'],
  path: ['File path', '文件路径'], file: ['Attachments', '附件'], output: ['Output path', '输出路径'],
  title: ['Title', '名称'], username: ['Username', '用户名'], duration: ['Duration', '时长'], permissions: ['Permissions', '权限'],
  enabled: ['Enabled (on/off)', '启用（on/off）'], hidden: ['Hidden (on/off)', '隐藏（on/off）'], sticker: ['Sticker set', '贴纸包'],
  invite: ['Invite link', '邀请链接'], confirmTitle: ['Exact group title', '群组完整名称'],
  limit: ['Limit', '数量上限'], delay: ['Delay (seconds)', '间隔（秒）'], hours: ['Last hours', '最近小时数'],
  offset: ['Offset', '跳过条数'], sender: ['Sender', '发送者'], regex: ['Regular expression', '正则表达式'],
  by: ['Group by', '分组粒度'], since: ['Start time', '开始时间'], until: ['End time', '结束时间'],
  minGap: ['Minimum gap', '最小缺口'], maxGaps: ['Maximum gaps', '缺口上限'], fromId: ['First message ID', '起始消息 ID'],
  toId: ['Last message ID', '结束消息 ID'], oldestFirst: ['Oldest first', '从最早开始'], dryRun: ['Preview only', '仅预览'],
  maxChats: ['Maximum chats', '聊天上限'], type: ['Type', '类型'], group: ['Groups only', '仅群组'], channel: ['Channels only', '仅频道'],
  reply: ['Reply to message ID', '回复消息 ID'], preview: ['Link preview', '链接预览'], attachment: ['Attachment number', '附件序号'],
  groupedId: ['Album ID', '相册 ID'], from: ['First message ID', '起始消息 ID'], to: ['Last message ID', '结束消息 ID'],
  date: ['Date', '日期'], all: ['All items', '全部条目'], force: ['Overwrite or force', '强制执行'], ext: ['File extensions', '文件扩展名'],
  concurrency: ['Concurrent downloads', '并发下载数'], persist: ['Reconnect automatically', '自动重连'],
  retrySeconds: ['Reconnect delay (seconds)', '重连间隔（秒）'], sendTo: ['Default outgoing chat', '默认发送聊天'],
  media: ['Show attachment details', '显示附件详情'], autoDownload: ['Download incoming attachments', '自动下载新附件'],
  save: ['Save to local database', '保存到本地数据库'], interactive: ['Interactive mode', '交互模式'],
  admin: ['Administrators only', '仅管理员'], expire: ['Expiration', '有效期'], requestNeeded: ['Approval required (on/off)', '需要审批（on/off）'],
  allAccounts: ['All accounts', '全部账号'], format: ['Export format', '导出格式'], full: ['Full history', '完整历史'],
  rebuild: ['Rebuild archive', '重新生成归档'], downloadMedia: ['Download attachments', '下载附件'],
  apiId: ['Telegram API ID', 'Telegram API ID'], apiHash: ['Telegram API hash', 'Telegram API hash'], proxy: ['Proxy URL', '代理 URL'],
  ownershipPassword: ['Telegram 2FA password', 'Telegram 两步验证密码'],
  showSecrets: ['Show secrets in result', '在结果中显示密钥'], verbose: ['Debug logging', '调试日志'],
  'status|on|off': ['Write access (status/on/off)', '写入权限（status/on/off）'],
}

function normalFieldName(name: string): string {
  return name.replace(/[-_]([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export function commandLabel(command: Pick<DesktopCommand, 'id' | 'path'>, locale: Locale): string {
  const index = locale === 'zh-CN' ? 1 : 0
  return command.path.map(part => commandWords[part]?.[index] ?? part.replace(/-/g, ' ')).join(' · ')
}

export function hasCommandTranslation(part: string): boolean {
  return Object.hasOwn(commandWords, part)
}

export function fieldLabel(field: Pick<DesktopField, 'name'>, locale: Locale): string {
  const name = normalFieldName(field.name)
  return fieldWords[name]?.[locale === 'zh-CN' ? 1 : 0] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, value => value.toUpperCase())
}

export function taskStatusLabel(status: DesktopTask['status'], locale: Locale): string {
  return workspaceMessages[locale][status]
}

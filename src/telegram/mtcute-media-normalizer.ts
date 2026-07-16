import { Buffer } from 'node:buffer'
import {
  FileLocation,
  type MessageMedia,
  type MessageMediaType,
} from '@mtcute/node'

import type { Attachment, JsonValue, MediaKind } from './media-types.js'

export type MtcuteMediaNormalization = {
  attachments: Attachment[]
  locations: ReadonlyMap<number, FileLocation>
}

const SUPPORTED_MTCUTE_MEDIA_TYPES = {
  photo: true,
  dice: true,
  contact: true,
  audio: true,
  voice: true,
  sticker: true,
  document: true,
  video: true,
  location: true,
  live_location: true,
  game: true,
  webpage: true,
  venue: true,
  poll: true,
  invoice: true,
  story: true,
  paid: true,
  todo: true,
} satisfies Record<MessageMediaType, true>

type AttachmentInput = {
  parent_attachment_index?: number | null
  role?: string
  kind: MediaKind
  subtype?: string | null
  downloadable?: boolean
  file_id?: string | null
  unique_file_id?: string | null
  file_name?: string | null
  mime_type?: string | null
  file_size?: number | null
  width?: number | null
  height?: number | null
  duration_seconds?: number | null
  thumbnail_file_id?: string | null
  thumbnail_unique_file_id?: string | null
  thumbnail_width?: number | null
  thumbnail_height?: number | null
  emoji?: string | null
  title?: string | null
  performer?: string | null
  latitude?: number | null
  longitude?: number | null
  address?: string | null
  phone_number?: string | null
  url?: string | null
  preview_jpeg_base64?: string | null
  metadata?: JsonValue
  location?: FileLocation | null
}

export function normalizeMtcuteMedia(input: {
  media: MessageMedia | null
  rawMedia?: unknown
}): MtcuteMediaNormalization {
  const builder = new AttachmentBuilder()
  const media = input.media
  if (media == null) {
    const rawConstructor = rawConstructorHint(input.rawMedia)
    if (rawConstructor != null) {
      builder.add({
        kind: 'unknown',
        downloadable: false,
        metadata: { constructor: rawConstructor },
      })
    }
    return builder.build()
  }

  addMedia(builder, media, null, 'primary')
  return builder.build()
}

function assertNever(value: never): never {
  throw new Error(`Unsupported mtcute media type: ${String(value)}`)
}

class AttachmentBuilder {
  private readonly attachments: Attachment[] = []
  private readonly locations = new Map<number, FileLocation>()

  add(input: AttachmentInput): Attachment {
    const attachment: Attachment = {
      attachment_index: this.attachments.length + 1,
      parent_attachment_index: input.parent_attachment_index ?? null,
      role: input.role ?? 'primary',
      kind: input.kind,
      subtype: input.subtype ?? null,
      downloadable: input.downloadable ?? false,
      file_id: input.file_id ?? null,
      unique_file_id: input.unique_file_id ?? null,
      file_name: input.file_name ?? null,
      mime_type: input.mime_type ?? null,
      file_size: input.file_size ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      duration_seconds: input.duration_seconds ?? null,
      thumbnail_file_id: input.thumbnail_file_id ?? null,
      thumbnail_unique_file_id: input.thumbnail_unique_file_id ?? null,
      thumbnail_width: input.thumbnail_width ?? null,
      thumbnail_height: input.thumbnail_height ?? null,
      emoji: input.emoji ?? null,
      title: input.title ?? null,
      performer: input.performer ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      address: input.address ?? null,
      phone_number: input.phone_number ?? null,
      url: input.url ?? null,
      preview_jpeg_base64: input.preview_jpeg_base64 ?? null,
      metadata: input.metadata ?? {},
    }
    if (attachment.parent_attachment_index != null && attachment.parent_attachment_index >= attachment.attachment_index) {
      throw new Error('Attachment parent index must be smaller than child index')
    }
    this.attachments.push(attachment)
    if (input.location != null) this.locations.set(attachment.attachment_index, input.location)
    return attachment
  }

  build(): MtcuteMediaNormalization {
    return {
      attachments: this.attachments,
      locations: this.locations,
    }
  }
}

function addMedia(builder: AttachmentBuilder, media: unknown, parent: Attachment | null, role: string): Attachment | null {
  if (media == null || typeof media !== 'object') return null
  const type = safeString(read(media, 'type'))
  if (!isSupportedMediaType(type)) {
    return builder.add({
      parent_attachment_index: parent?.attachment_index,
      role,
      kind: 'unknown',
      downloadable: false,
      metadata: {},
    })
  }

  // Keep the compile-time sentinel visibly tied to the runtime dispatcher.
  SUPPORTED_MTCUTE_MEDIA_TYPES[type]

  switch (type) {
    case 'photo':
      return addPhoto(builder, media, parent, role)
    case 'video':
      return addVideo(builder, media, parent, role)
    case 'audio':
      return addAudio(builder, media, parent, role)
    case 'voice':
      return addVoice(builder, media, parent, role)
    case 'sticker':
      return addSticker(builder, media, parent, role)
    case 'document':
      return addDocument(builder, media, parent, role)
    case 'contact':
      return addContact(builder, media, parent, role)
    case 'location':
      return addLocation(builder, media, 'location', parent, role)
    case 'live_location':
      return addLocation(builder, media, 'live_location', parent, role)
    case 'venue':
      return addVenue(builder, media, parent, role)
    case 'dice':
      return addDice(builder, media, parent, role)
    case 'todo':
      return addTodo(builder, media, parent, role)
    case 'game':
      return addGame(builder, media, parent, role)
    case 'webpage':
      return addWebpage(builder, media, parent, role)
    case 'poll':
      return addPoll(builder, media, parent, role)
    case 'invoice':
      return addInvoice(builder, media, parent, role)
    case 'story':
      return addStory(builder, media, parent, role)
    case 'paid':
      return addPaidMedia(builder, media, parent, role)
    default:
      assertNever(type)
  }
}

function addPhoto(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const metadata = compactMetadata({
    spoiler: safeBoolean(read(media, 'hasSpoiler')),
    ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
  })
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'photo',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata,
    location: fileLocation(media),
  })
  addChild(builder, attachment, 'live_photo_video', media, 'livePhotoVideo')
  return attachment
}

function addVideo(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const metadata = compactMetadata({
    spoiler: safeBoolean(read(media, 'hasSpoiler')),
    ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
    codec: safeString(read(media, 'codec')),
    video_start_ts: safeNumber(read(media, 'videoStartTs')),
    video_timestamp: safeNumber(read(media, 'videoTimestamp')),
  })
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'video',
    subtype: videoSubtype(media),
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    duration_seconds: safeNumber(read(media, 'duration')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata,
    location: fileLocation(media),
  })
  addChild(builder, attachment, 'cover', media, 'videoCover')
  return attachment
}

function addAudio(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const performer = safeString(read(media, 'performer'))
  const title = safeString(read(media, 'title'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'audio',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    duration_seconds: safeNumber(read(media, 'duration')),
    performer,
    title,
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({ performer, title }),
    location: fileLocation(media),
  })
}

function addVoice(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'voice',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    duration_seconds: safeNumber(read(media, 'duration')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({
      ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
      waveform: safeNumberArray(read(media, 'waveform')),
    }),
    location: fileLocation(media),
  })
}

function addSticker(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const emoji = safeString(read(media, 'emoji'))
  const stickerType = safeString(read(media, 'stickerType'))
  const sourceType = safeString(read(media, 'sourceType'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'sticker',
    subtype: stickerSourceSubtype(sourceType),
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    emoji,
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({
      emoji,
      sticker_type: stickerType,
      source_type: sourceType,
      premium: safeBoolean(read(media, 'isPremiumSticker')),
      valid: safeBoolean(read(media, 'isValidSticker')),
      custom_emoji_free: safeBoolean(read(media, 'customEmojiFree')),
      custom_emoji_id: longToString(read(media, 'customEmojiId')),
      mask_position: maskPosition(read(media, 'maskPosition')),
    }),
    location: fileLocation(media),
  })
}

function addDocument(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const webUrl = safeString(read(media, 'url'))
  const isWebDocument = webUrl != null
  const isDownloadable = isWebDocument ? safeBoolean(read(media, 'isDownloadable')) === true : true
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'document',
    subtype: isWebDocument ? 'web' : null,
    downloadable: isDownloadable,
    file_id: isWebDocument ? null : safeFileString(media, 'fileId'),
    unique_file_id: isWebDocument ? null : safeFileString(media, 'uniqueFileId'),
    file_name: isWebDocument ? null : safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    url: webUrl,
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: isWebDocument ? compactMetadata({ url: webUrl }) : {},
    location: isDownloadable ? fileLocation(media) : null,
  })
}

function addContact(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const firstName = safeString(read(media, 'firstName'))
  const lastName = safeString(read(media, 'lastName'))
  const phoneNumber = safeString(read(media, 'phoneNumber'))
  const userId = safeNumber(read(media, 'userId'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'contact',
    downloadable: false,
    phone_number: phoneNumber,
    metadata: compactMetadata({
      first_name: firstName,
      last_name: lastName,
      phone_number: phoneNumber,
      user_id: userId,
    }),
  })
}

function addLocation(builder: AttachmentBuilder, media: object, kind: 'location' | 'live_location', parent: Attachment | null, role: string): Attachment {
  const latitude = safeNumber(read(media, 'latitude'))
  const longitude = safeNumber(read(media, 'longitude'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind,
    downloadable: false,
    latitude,
    longitude,
    metadata: compactMetadata({
      latitude,
      longitude,
      accuracy_radius: safeNumber(read(media, 'radius')),
      period: kind === 'live_location' ? safeNumber(read(media, 'period')) : null,
      heading: kind === 'live_location' ? safeNumber(read(media, 'heading')) : null,
    }),
  })
}

function addVenue(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const location = read(media, 'location')
  const locationObject = location != null && typeof location === 'object' ? location : {}
  const source = read(media, 'source')
  const sourceObject = source != null && typeof source === 'object' ? source : {}
  const title = safeString(read(media, 'title'))
  const address = safeString(read(media, 'address'))
  const latitude = safeNumber(read(locationObject, 'latitude'))
  const longitude = safeNumber(read(locationObject, 'longitude'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'venue',
    downloadable: false,
    title,
    address,
    latitude,
    longitude,
    metadata: compactMetadata({
      title,
      address,
      latitude,
      longitude,
      accuracy_radius: safeNumber(read(locationObject, 'radius')),
      provider: safeString(read(sourceObject, 'provider')),
      provider_id: safeString(read(sourceObject, 'id')),
      provider_type: safeString(read(sourceObject, 'type')),
    }),
  })
}

function addDice(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const emoji = safeString(read(media, 'emoji'))
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'dice',
    downloadable: false,
    emoji,
    metadata: compactMetadata({
      emoji,
      value: safeNumber(read(media, 'value')),
    }),
  })
}

function addTodo(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const title = textValue(read(media, 'title'))
  const items = read(media, 'items')
  return builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'todo',
    downloadable: false,
    title,
    metadata: compactMetadata({
      title,
      others_can_append: safeBoolean(read(media, 'othersCanAppend')),
      others_can_complete: safeBoolean(read(media, 'othersCanComplete')),
      items: Array.isArray(items) ? items.map(todoItemMetadata) : [],
    }),
  })
}

function addGame(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'game',
    downloadable: false,
    title: safeString(read(media, 'title')),
    metadata: metadataObject({
      id: longToString(read(media, 'id')),
      title: safeString(read(media, 'title')),
      description: safeString(read(media, 'description')),
      short_name: safeString(read(media, 'shortName')),
    }),
  })
  addChild(builder, attachment, 'game_media', media, 'photo')
  addChild(builder, attachment, 'game_media', media, 'animation')
  return attachment
}

function addWebpage(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const previewResult = readMaybe(media, 'preview')
  const preview = previewResult.value != null && typeof previewResult.value === 'object' ? previewResult.value : {}
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'webpage',
    downloadable: false,
    title: safeString(read(preview, 'title')),
    url: safeString(read(preview, 'url')),
    metadata: metadataObject({
      id: longToString(read(preview, 'id')),
      url: safeString(read(preview, 'url')),
      display_url: safeString(read(preview, 'displayUrl')),
      preview_type: safeString(read(preview, 'previewType')),
      site_name: safeString(read(preview, 'siteName')),
      title: safeString(read(preview, 'title')),
      description: safeString(read(preview, 'description')),
      author: safeString(read(preview, 'author')),
      embed_url: safeString(read(preview, 'embedUrl')),
      embed_type: safeString(read(preview, 'embedType')),
      embed_width: safeNumber(read(preview, 'embedWidth')),
      embed_height: safeNumber(read(preview, 'embedHeight')),
      display_size: safeString(read(media, 'displaySize')) ?? safeNumber(read(media, 'displaySize')),
      manual: safeBoolean(read(media, 'manual')),
      safe: safeBoolean(read(media, 'safe')),
      getter_errors: previewResult.thrown ? ['preview'] : undefined,
    }),
  })
  if (previewResult.thrown) addUnknownChild(builder, attachment, 'webpage_media', 'preview')
  else {
    addChild(builder, attachment, 'webpage_media', preview, 'photo', 'preview.photo')
    addChild(builder, attachment, 'webpage_media', preview, 'document', 'preview.document')
  }
  return attachment
}

function addPoll(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const getterErrors: string[] = []
  const question = readMaybe(media, 'question')
  if (question.thrown) getterErrors.push('question')
  const answersResult = readMaybe(media, 'answers')
  if (answersResult.thrown) getterErrors.push('answers')
  const answers = safeList(answersResult.value)
  const metadata = metadataObject({
    id: longToString(read(media, 'id')),
    question: textValue(question.value),
    voters: safeNumber(read(media, 'voters')),
    is_closed: safeBoolean(read(media, 'isClosed')),
    is_public: safeBoolean(read(media, 'isPublic')),
    is_quiz: safeBoolean(read(media, 'isQuiz')),
    is_multiple: safeBoolean(read(media, 'isMultiple')),
    is_creator: safeBoolean(read(media, 'isCreator')),
    can_add_answers: safeBoolean(read(media, 'canAddAnswers')),
    is_revoting_disabled: safeBoolean(read(media, 'isRevotingDisabled')),
    shuffle_answers: safeBoolean(read(media, 'shuffleAnswers')),
    hide_results_until_close: safeBoolean(read(media, 'hideResultsUntilClose')),
    has_unread_votes: safeBoolean(read(media, 'hasUnreaVotes')),
    is_subscribers_only: safeBoolean(read(media, 'isSubscribersOnly')),
    countries: safeStringArray(read(media, 'countries')) ?? [],
    can_view_stats: safeBoolean(read(media, 'canViewStats')),
    solution: textValue(read(media, 'solution')),
    answers: answers.map(pollAnswerMetadata),
    getter_errors: getterErrors.length > 0 ? getterErrors : undefined,
  })
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'poll',
    downloadable: false,
    metadata,
  })
  addChild(builder, attachment, 'poll_attached_media', media, 'attachedMedia')
  answers.forEach((answer, index) => {
    if (answer == null || typeof answer !== 'object') return
    const child = addChild(builder, attachment, 'poll_answer_media', answer, 'media', `answers[${index}].media`)
    if (child != null) child.metadata = metadataWith(child.metadata, { poll_answer_index: index })
  })
  addChild(builder, attachment, 'poll_solution_media', media, 'solutionMedia')
  return attachment
}

function addInvoice(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const getterErrors: string[] = []
  const preview = readMaybe(media, 'extendedMediaPreview')
  if (preview.thrown) getterErrors.push('extendedMediaPreview')
  const full = readMaybe(media, 'extendedMedia')
  if (full.thrown) getterErrors.push('extendedMedia')
  const previewObject = preview.value != null && typeof preview.value === 'object' ? preview.value : null
  const metadata = metadataObject({
    title: safeString(read(media, 'title')),
    description: safeString(read(media, 'description')),
    receipt_message_id: safeNumber(read(media, 'receiptMessageId')),
    currency: safeString(read(media, 'currency')),
    amount: longToString(read(media, 'amount')),
    start_param: safeString(read(media, 'startParam')),
    shipping_address_requested: callBoolean(media, 'isShippingAddressRequested'),
    test: callBoolean(media, 'isTest'),
    extended_media_state: safeString(read(media, 'extendedMediaState')),
    preview_width: previewObject == null ? null : safeNumber(read(previewObject, 'width')),
    preview_height: previewObject == null ? null : safeNumber(read(previewObject, 'height')),
    preview_duration_seconds: previewObject == null ? null : safeNumber(read(previewObject, 'videoDuration')),
    getter_errors: getterErrors.length > 0 ? getterErrors : undefined,
  })
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'invoice',
    downloadable: false,
    title: safeString(read(media, 'title')),
    preview_jpeg_base64: previewObject == null ? null : previewThumbnailBase64(previewObject),
    metadata,
  })
  const productPhoto = readMaybe(media, 'photo')
  if (productPhoto.thrown) addUnknownChild(builder, attachment, 'invoice_product_media', 'photo')
  else if (productPhoto.value != null) addWebDocument(builder, productPhoto.value, attachment, 'invoice_product_media')
  if (!full.thrown && full.value != null) addMedia(builder, full.value, attachment, 'invoice_extended_media')
  return attachment
}

function addStory(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const storyResult = readMaybe(media, 'story')
  const story = storyResult.value != null && typeof storyResult.value === 'object' ? storyResult.value : null
  const available = story != null
  const peer = read(media, 'peer')
  const peerObject = peer != null && typeof peer === 'object' ? peer : {}
  const metadata: Record<string, JsonValue> = {
    peer_id: safeNumber(read(peerObject, 'id')) ?? safeNumber(read(media, 'peerId')),
    peer_name: safeString(read(peerObject, 'displayName')) ?? safeString(read(peerObject, 'name')) ?? safeString(read(media, 'peerName')),
    story_id: safeNumber(read(media, 'storyId')),
    is_mention: safeBoolean(read(media, 'isMention')),
    available,
  }
  if (storyResult.thrown) metadata.getter_errors = ['story']
  if (story != null) {
    metadata.story_date = dateString(read(story, 'date'))
    metadata.story_expire_date = dateString(read(story, 'expireDate'))
    metadata.caption = textValue(read(story, 'caption'))
  }
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'story',
    downloadable: false,
    metadata,
  })
  if (storyResult.thrown) addUnknownChild(builder, attachment, 'story_media', 'story')
  else if (story != null) addChild(builder, attachment, 'story_media', story, 'media', 'story.media')
  return attachment
}

function addPaidMedia(builder: AttachmentBuilder, media: object, parent: Attachment | null, role: string): Attachment {
  const previews = safeList(read(media, 'previews'))
  const medias = safeList(read(media, 'medias')).filter((item) => item != null)
  const attachment = builder.add({
    parent_attachment_index: parent?.attachment_index,
    role,
    kind: 'paid_media',
    downloadable: false,
    metadata: metadataObject({
      price: longToString(read(media, 'price')),
      preview_count: previews.length,
      item_count: medias.length,
    }),
  })
  for (const preview of previews) {
    builder.add({
      parent_attachment_index: attachment.attachment_index,
      role: 'paid_preview',
      kind: 'paid_media',
      subtype: 'preview',
      downloadable: false,
      metadata: {},
    })
  }
  for (const item of medias) {
    addMedia(builder, item, attachment, 'paid_item')
  }
  return attachment
}

function addWebDocument(builder: AttachmentBuilder, media: unknown, parent: Attachment, role: string): Attachment | null {
  if (media == null || typeof media !== 'object') return null
  const url = safeString(read(media, 'url'))
  const isDownloadable = safeBoolean(read(media, 'isDownloadable')) === true
  return builder.add({
    parent_attachment_index: parent.attachment_index,
    role,
    kind: 'document',
    subtype: 'web',
    downloadable: isDownloadable,
    file_id: null,
    unique_file_id: null,
    file_name: null,
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    url,
    metadata: metadataObject({
      url,
      mime_type: safeString(read(media, 'mimeType')),
      file_size: safeNumber(read(media, 'fileSize')),
    }),
    location: isDownloadable ? fileLocation(media) : null,
  })
}

function addChild(
  builder: AttachmentBuilder,
  parent: Attachment,
  role: string,
  source: object,
  property: string,
  getterName = property,
): Attachment | null {
  const child = readMaybe(source, property)
  if (child.thrown) return addUnknownChild(builder, parent, role, getterName)
  if (child.value == null) return null
  return addMedia(builder, child.value, parent, role)
}

function addUnknownChild(builder: AttachmentBuilder, parent: Attachment, role: string, getter: string): Attachment {
  return builder.add({
    parent_attachment_index: parent.attachment_index,
    role,
    kind: 'unknown',
    downloadable: false,
    metadata: { getter },
  })
}

function videoSubtype(media: object): string {
  if (safeBoolean(read(media, 'isRound')) === true) return 'round'
  if (safeBoolean(read(media, 'isLegacyGif')) === true) return 'legacy_gif'
  if (safeBoolean(read(media, 'isAnimation')) === true) return 'animation'
  return 'normal'
}

function stickerSourceSubtype(sourceType: string | null): string | null {
  if (sourceType === 'static' || sourceType === 'animated' || sourceType === 'video') return sourceType
  return null
}

function embeddedPreviewBase64(media: object): string | null {
  try {
    const thumbnails = read(media, 'thumbnails')
    if (!Array.isArray(thumbnails)) return null
    const thumbnail = thumbnails.find((item) => {
      if (item == null || typeof item !== 'object') return false
      return read(item, 'type') === 'i'
    })
    if (thumbnail == null || typeof thumbnail !== 'object') return null
    const location = read(thumbnail, 'location')
    if (!(location instanceof Uint8Array)) return null
    return Buffer.from(location).toString('base64')
  } catch {
    return null
  }
}

function previewThumbnailBase64(media: object): string | null {
  const thumbnail = read(media, 'thumbnail')
  if (thumbnail == null || typeof thumbnail !== 'object') return null
  const location = read(thumbnail, 'location')
  if (!(location instanceof Uint8Array)) return null
  return Buffer.from(location).toString('base64')
}

function safeFileString(source: object, property: 'fileId' | 'uniqueFileId'): string | null {
  try {
    return safeString(read(source, property))
  } catch {
    return null
  }
}

function read(source: unknown, property: string): unknown {
  if (source == null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[property]
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function safeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function callBoolean(source: object, property: string): boolean | null {
  const value = read(source, property)
  if (typeof value !== 'function') return null
  try {
    return safeBoolean(value.call(source))
  } catch {
    return null
  }
}

function safeNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return numbers.length === value.length ? numbers : null
}

function safeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : null
}

function safeList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return safeString(value)
  if (value != null && typeof value === 'object') {
    return safeString(read(value, 'text'))
  }
  return null
}

function dateString(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null
}

function longToString(value: unknown): string | null {
  try {
    if (value == null) return null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
      const stringified = (value as { toString(): string }).toString()
      return safeString(stringified)
    }
    return null
  } catch {
    return null
  }
}

function maskPosition(value: unknown): JsonValue {
  if (value == null || typeof value !== 'object') return null
  return compactMetadata({
    point: safeString(read(value, 'point')),
    x: safeNumber(read(value, 'x')),
    y: safeNumber(read(value, 'y')),
    scale: safeNumber(read(value, 'scale')),
  })
}

function todoItemMetadata(value: unknown): JsonValue {
  const item = value != null && typeof value === 'object' ? value : {}
  const completedBy = read(item, 'completedBy')
  const completedByObject = completedBy != null && typeof completedBy === 'object' ? completedBy : {}
  const completedDate = read(item, 'completedDate')
  return {
    id: safeNumber(read(item, 'id')),
    text: textValue(read(item, 'text')),
    is_completed: safeBoolean(read(item, 'isCompleted')),
    completed_by_id: safeNumber(read(completedByObject, 'id')),
    completed_by_name: safeString(read(completedByObject, 'displayName')) ?? safeString(read(completedByObject, 'name')),
    completed_date: completedDate instanceof Date ? completedDate.toISOString() : null,
  }
}

function pollAnswerMetadata(value: unknown, index: number): JsonValue {
  const answer = value != null && typeof value === 'object' ? value : {}
  const data = read(answer, 'data')
  return {
    answer_index: index,
    text: textValue(read(answer, 'text')),
    data_base64: data instanceof Uint8Array ? Buffer.from(data).toString('base64') : null,
    voters: safeNumber(read(answer, 'voters')),
    chosen: safeBoolean(read(answer, 'chosen')),
    correct: safeBoolean(read(answer, 'correct')),
  }
}

function metadataWith(metadata: JsonValue, values: Record<string, JsonValue>): JsonValue {
  if (metadata == null || Array.isArray(metadata) || typeof metadata !== 'object') return values
  return { ...metadata, ...values }
}

function readMaybe(source: unknown, property: string): { value: unknown, thrown: boolean } {
  if (source == null || typeof source !== 'object') return { value: undefined, thrown: false }
  try {
    return { value: (source as Record<string, unknown>)[property], thrown: false }
  } catch {
    return { value: undefined, thrown: true }
  }
}

function compactMetadata(values: Record<string, JsonValue | undefined>): JsonValue {
  const metadata: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) metadata[key] = value
  }
  return metadata
}

function metadataObject(values: Record<string, JsonValue | undefined>): JsonValue {
  const metadata: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}

function isSupportedMediaType(value: string | null): value is MessageMediaType {
  return value != null && value in SUPPORTED_MTCUTE_MEDIA_TYPES
}

function fileLocation(value: unknown): FileLocation | null {
  return value instanceof FileLocation ? value : null
}

function rawConstructorHint(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null
  return safeString(read(value, '_'))
}

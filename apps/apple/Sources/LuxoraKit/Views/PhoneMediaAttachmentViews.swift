#if os(iOS)
import SwiftUI
#if canImport(UIKit)
import UIKit
import PhotosUI
#endif

// MARK: - Media attachments (Telegram-style photo/file messaging)

struct PhoneComposerMediaStrip: View {
    let media: [PendingMediaAttachment]
    let onRemove: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(media) { item in
                    ZStack(alignment: .topTrailing) {
                        if item.kind == "image", let preview = UIImage(data: item.data) {
                            Image(uiImage: preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        } else {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.secondary.opacity(0.14))
                                .frame(width: 64, height: 64)
                                .overlay {
                                    VStack(spacing: 3) {
                                        Image(systemName: "doc.fill")
                                            .font(.system(size: 18, weight: .semibold))
                                        Text(item.fileName)
                                            .font(.system(size: 8))
                                            .lineLimit(1)
                                            .padding(.horizontal, 3)
                                    }
                                }
                        }
                        Button {
                            onRemove(item.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 17))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.62))
                        }
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Убрать файл \(item.fileName)")
                    }
                    .accessibilityIdentifier("composer-media-chip")
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
        }
    }
}

struct PhoneMediaPickerSheet: View {
    let onPhotosPicked: ([PhotosPickerItem]) -> Void
    let onPickFile: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 18) {
            Capsule()
                .fill(Color.secondary.opacity(0.35))
                .frame(width: 40, height: 5)
                .padding(.top, 10)

            Text("Прикрепить")
                .font(.headline)

            PhotosPicker(
                selection: Binding(
                    get: { [] },
                    set: { items in
                        guard !items.isEmpty else { return }
                        onPhotosPicked(items)
                        dismiss()
                    }
                ),
                maxSelectionCount: 10,
                matching: .images
            ) {
                Label("Фото из галереи", systemImage: "photo.on.rectangle.angled")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 46)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("media-picker-photos")

            Button {
                dismiss()
                onPickFile()
            } label: {
                Label("Файл из хранилища", systemImage: "folder.fill")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 46)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("media-picker-file")

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationDragIndicator(.hidden)
        .accessibilityIdentifier("media-picker-sheet")
    }
}

struct PhoneMessageAttachmentList: View {
    let attachments: [MessageAttachment]
    let voiceCache: AuthenticatedAvatarImageCache?
    let cache: AuthenticatedAvatarImageCache?
    let onOpenImage: (MessageAttachment) -> Void
    var transcriptionAllowed: Bool = false
    var transcript: String?
    var onSubmitTranscript: ((String) -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    PhoneAttachmentImageView(
                        attachment: attachment,
                        cache: cache,
                        onOpen: { onOpenImage(attachment) }
                    )
                } else if attachment.isVoice {
                    PhoneVoiceMessageView(
                        attachment: attachment,
                        cache: voiceCache,
                        transcriptionAllowed: transcriptionAllowed,
                        transcript: transcript,
                        onSubmitTranscript: onSubmitTranscript
                    )
                } else {
                    PhoneFileAttachmentRow(attachment: attachment)
                }
            }
        }
    }
}

struct PhoneAttachmentImageView: View {
    let attachment: MessageAttachment
    let cache: AuthenticatedAvatarImageCache?
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.secondary.opacity(0.16))
                    .overlay {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.title2)
                    }
                    .frame(height: 160)
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.secondary.opacity(0.12))
                    .overlay { ProgressView() }
                    .frame(height: 180)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 216)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture(perform: onOpen)
        .task(id: attachment.id) {
            await load()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Изображение: \(attachment.fileName)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("message-attachment-image")
    }

    private func load() async {
        guard let cache else {
            failed = true
            return
        }
        do {
            let data = try await cache.data(for: attachment.downloadPath)
            image = UIImage(data: data)
            if image == nil { failed = true }
        } catch {
            failed = true
        }
    }
}

struct PhoneFileAttachmentRow: View {
    let attachment: MessageAttachment

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(LuxoraTheme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.fileName)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                Text(attachment.formattedSize)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Файл: \(attachment.fileName), \(attachment.formattedSize)")
        .accessibilityIdentifier("message-attachment-file")
    }
}

struct PhoneAttachmentViewer: View {
    let attachment: MessageAttachment
    let cache: AuthenticatedAvatarImageCache?
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .scaleEffect(scale)
                        .gesture(
                            MagnificationGesture()
                                .onChanged { value in
                                    scale = min(max(1, value), 5)
                                }
                                .onEnded { _ in
                                    withAnimation { scale = 1 }
                                }
                        )
                }
            } else if failed {
                VStack(spacing: 10) {
                    Image(systemName: "photo.badge.exclamationmark")
                        .font(.largeTitle)
                    Text("Не удалось загрузить изображение")
                        .font(.callout)
                }
                .foregroundStyle(.white.opacity(0.7))
            } else {
                ProgressView()
                    .tint(.white)
            }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                            .background(.white.opacity(0.14), in: Circle())
                    }
                    .accessibilityIdentifier("attachment-viewer-close")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(attachment.fileName)
                            .font(.callout.weight(.semibold))
                            .lineLimit(1)
                        Text(attachment.formattedSize)
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    .foregroundStyle(.white)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
        }
        .task {
            guard let cache else {
                failed = true
                return
            }
            do {
                let data = try await cache.data(for: attachment.downloadPath)
                image = UIImage(data: data)
                if image == nil { failed = true }
            } catch {
                failed = true
            }
        }
    }
}

struct PhoneScheduleMessageSheet: View {
    let draft: String
    @Binding var sendAt: Date
    let errorMessage: String?
    let onSchedule: (String, Date) -> Void
    let scheduled: [ScheduledMessage]
    let onCancel: (UUID) -> Void

    @State private var text: String = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Новое отложенное") {
                    TextField("Текст сообщения", text: $text, axis: .vertical)
                        .lineLimit(2...6)
                        .accessibilityIdentifier("schedule-text")
                    DatePicker("Отправить", selection: $sendAt, in: Date().addingTimeInterval(60)...Date().addingTimeInterval(366 * 86_400), displayedComponents: [.date, .hourAndMinute])
                        .accessibilityIdentifier("schedule-date")
                    Button("Запланировать") {
                        onSchedule(text, sendAt)
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("schedule-confirm")
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("schedule-error")
                    }
                }

                if !scheduled.isEmpty {
                    Section("Ожидают отправки") {
                        ForEach(scheduled) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.body)
                                    .lineLimit(2)
                                Text(item.sendAt, style: .date)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                + Text(" ") + Text(item.sendAt, style: .time)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    onCancel(item.id)
                                } label: {
                                    Label("Отменить", systemImage: "trash")
                                }
                                .accessibilityIdentifier("schedule-cancel")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Отправить позже")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
            .onAppear {
                if text.isEmpty { text = draft }
            }
        }
        .accessibilityIdentifier("schedule-sheet")
    }
}
#endif
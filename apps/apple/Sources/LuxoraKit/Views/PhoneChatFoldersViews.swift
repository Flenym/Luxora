#if os(iOS)
import SwiftUI

struct PhoneChatFolderRail: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var store: ChatFoldersStore
    let conversations: [Conversation]

    @State private var scrollPosition: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                chip(
                    id: "all",
                    title: "Все",
                    count: conversations.lazy.filter { !$0.isArchived }.count,
                    isSelected: store.selectedFolderID == nil && !store.isArchiveSelected
                ) {
                    select(nil, scrollID: "all")
                }
                .accessibilityIdentifier("chat-folder-rail-all")
                .id("all")

                if conversations.contains(where: \.isArchived) {
                    chip(
                        id: "archive",
                        title: "Архив",
                        count: conversations.lazy.filter(\.isArchived).count,
                        isSelected: store.isArchiveSelected
                    ) {
                        selectArchive()
                    }
                    .accessibilityIdentifier("chat-folder-rail-archive")
                    .id("archive")
                }

                ForEach(store.folders) { folder in
                    chip(
                        id: folder.id.apiPathComponent,
                        title: folder.title,
                        count: folder.projectedConversations(conversations).count,
                        isSelected: store.selectedFolderID == folder.id
                    ) {
                        select(folder.id, scrollID: folder.id.apiPathComponent)
                    }
                    .accessibilityIdentifier("chat-folder-rail-\(folder.id.apiPathComponent)")
                    .id(folder.id.apiPathComponent)
                }
            }
            .scrollTargetLayout()
        }
        .frame(minHeight: 48)
        .contentMargins(.horizontal, 4, for: .scrollContent)
        .background(Color.secondary.opacity(0.09), in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.16), lineWidth: 0.5))
        .clipShape(Capsule())
        .padding(.horizontal, 16)
        .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        .scrollPosition(id: $scrollPosition)
        .task {
            if scrollPosition == nil {
                scrollPosition = store.selectedFolderID?.apiPathComponent ?? "all"
                if store.isArchiveSelected { scrollPosition = "archive" }
            }
            if store.loadState == .idle {
                _ = await store.refresh()
            }
        }
        .onChange(of: store.selectedFolderID) { _, selected in
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
                scrollPosition = store.isArchiveSelected
                    ? "archive"
                    : selected?.apiPathComponent ?? "all"
            }
        }
        .onChange(of: store.isArchiveSelected) { _, isArchive in
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
                scrollPosition = isArchive
                    ? "archive"
                    : store.selectedFolderID?.apiPathComponent ?? "all"
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Папки чатов, горизонтальный список")
        .accessibilityHint("Проведите влево или вправо, чтобы увидеть синхронизированные папки.")
        .accessibilityIdentifier("chat-folder-rail")
    }

    private func chip(
        id _: String,
        title: String,
        count: Int,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                    .lineLimit(1)
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(
                            isSelected ? LuxoraTheme.deepViolet : Color(uiColor: .label)
                        )
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(
                            isSelected ? Color.white : Color.primary.opacity(0.10),
                            in: Capsule()
                        )
                }
            }
            .font(.subheadline.weight(isSelected ? .semibold : .regular))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .frame(minHeight: 44)
            .foregroundStyle(isSelected ? .white : Color(uiColor: .label))
            .background {
                if isSelected {
                    Capsule().fill(LuxoraTheme.brandGradient)
                }
            }
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("\(title), чатов: \(count)")
        .accessibilityValue(isSelected ? "Выбрано" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func select(_ id: UUID?, scrollID: String) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
            store.select(id)
            scrollPosition = scrollID
        }
    }

    private func selectArchive() {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
            store.selectArchive()
            scrollPosition = "archive"
        }
    }
}

struct PhoneChatFoldersSettingsView: View {
    @Environment(\.editMode) private var editMode
    @Bindable var store: ChatFoldersStore
    let conversations: [Conversation]

    @State private var editor: FolderEditorDestination?
    @State private var deletionCandidate: ChatFolder?
    @AppStorage("luxora.chatFolders.showNames") private var showsFolderNames = true

    private var folderCountSummary: String {
        "\(store.folders.count) из \(ChatFolderContract.maximumFolders)"
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Text("🗂️")
                        .font(.system(size: 84))
                        .accessibilityHidden(true)
                    Text("Соберите нужные чаты и переключайтесь между папками над списком переписок.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            if store.loadState == .loading, store.folders.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Синхронизируем папки…")
                    }
                    .accessibilityIdentifier("chat-folders-loading")
                }
            } else if case let .failed(message) = store.loadState {
                Section {
                    PhoneChatFolderFailureRow(
                        title: "Не удалось загрузить папки",
                        detail: message,
                        retry: { Task { _ = await store.refresh(force: true) } }
                    )
                }
            }

            Section {
                Button {
                    editor = .create
                } label: {
                    PhoneChatFolderActionRow(
                        symbol: "plus",
                        color: LuxoraTheme.electricBlue,
                        title: "Создать папку",
                        detail: "До \(ChatFolderContract.maximumFolders) синхронизированных папок"
                    )
                }
                .buttonStyle(.plain)
                .disabled(
                    store.folders.count >= ChatFolderContract.maximumFolders
                        || store.mutationState == .loading
                )
                .accessibilityHint("Открывает редактор новой папки")
                .accessibilityIdentifier("chat-folders-create-row")

                Button {
                    store.select(nil)
                } label: {
                    PhoneChatFolderSettingsRow(
                        symbol: "tray.full.fill",
                        color: LuxoraTheme.electricBlue,
                        title: "Все чаты",
                        detail: "Системная папка",
                        count: conversations.lazy.filter { !$0.isArchived }.count,
                        isSelected: store.selectedFolderID == nil && !store.isArchiveSelected
                    )
                }
                .buttonStyle(.plain)
                .id("chat-folders-all")
                .accessibilityHint("Выбирает системную папку над списком чатов")
                .accessibilityValue(
                    store.selectedFolderID == nil && !store.isArchiveSelected ? "Выбрано" : ""
                )
                .accessibilityAddTraits(
                    store.selectedFolderID == nil && !store.isArchiveSelected ? .isSelected : []
                )
                .accessibilityIdentifier("chat-folders-all")

                ForEach(store.folders) { folder in
                    folderSettingsRow(folder)
                }
                .onMove(perform: moveFolders)
            } header: {
                Text("Папки")
            } footer: {
                Text("Нажмите папку, чтобы изменить её. Кнопка «Править» включает перетаскивание порядка; новый порядок сохраняется на сервере.")
            }

            if store.folders.count < ChatFolderContract.maximumFolders {
                Section("Рекомендуемые папки") {
                    if !store.folders.contains(where: { $0.title == "Непрочитанные" }) {
                        recommendation(
                            title: "Непрочитанные",
                            detail: "Новые сообщения из всех чатов",
                            symbol: "circlebadge.fill"
                        ) {
                            store.create(ChatFolderDraft(
                                title: "Непрочитанные",
                                rules: ChatFolderRules(
                                    includeKinds: ChatFolderChatKind.allCases,
                                    unreadOnly: true,
                                    excludeMuted: false,
                                    includeArchived: false
                                ),
                                overrides: []
                            ))
                        }
                    }
                    if !store.folders.contains(where: { $0.title == "Личные" }) {
                        recommendation(
                            title: "Личные",
                            detail: "Только личные переписки",
                            symbol: "person.fill"
                        ) {
                            store.create(ChatFolderDraft(
                                title: "Личные",
                                rules: ChatFolderRules(
                                    includeKinds: [.direct],
                                    unreadOnly: false,
                                    excludeMuted: false,
                                    includeArchived: false
                                ),
                                overrides: []
                            ))
                        }
                    }
                }
            }

            PhoneChatFolderSynchronizationSection(folderCountSummary: folderCountSummary)

            Section {
                Toggle("Показывать названия папок", isOn: $showsFolderNames)
                    .accessibilityIdentifier("chat-folders-show-names")
            } header: {
                Text("На этом iPhone")
            } footer: {
                Text("Когда включено, под названием чата появляются метки всех синхронизированных папок, в которые он входит. Настройка хранится только на этом iPhone.")
            }

            if let failure = store.mutationFailure {
                Section {
                    PhoneChatFolderMutationFailureView(failure: failure, store: store)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Папки с чатами")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                EditButton()
                    .disabled(store.folders.count < 2 || store.mutationState == .loading)
                    .accessibilityIdentifier("chat-folders-edit-order")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Создать", systemImage: "plus") {
                    editor = .create
                }
                .disabled(
                    store.folders.count >= ChatFolderContract.maximumFolders
                        || store.mutationState == .loading
                )
                .accessibilityIdentifier("chat-folders-create")
            }
        }
        .overlay {
            if store.mutationState == .loading {
                ProgressView()
                    .padding(13)
                    .background(.regularMaterial, in: Circle())
                    .accessibilityLabel("Сохраняем папки")
                    .accessibilityIdentifier("chat-folders-saving")
            }
        }
        .refreshable { _ = await store.refresh(force: true) }
        .task {
            if store.loadState == .idle {
                _ = await store.refresh()
            }
        }
        .sheet(item: $editor) { destination in
            PhoneChatFolderEditorView(
                store: store,
                conversations: conversations,
                destination: destination
            )
        }
        .confirmationDialog(
            "Удалить папку?",
            isPresented: Binding(
                get: { deletionCandidate != nil },
                set: { if !$0 { deletionCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let deletionCandidate {
                Button("Удалить «\(deletionCandidate.title)»", role: .destructive) {
                    store.delete(
                        folderID: deletionCandidate.id,
                        expectedRevision: deletionCandidate.revision
                    )
                    self.deletionCandidate = nil
                }
            }
            Button("Отмена", role: .cancel) { deletionCandidate = nil }
        } message: {
            Text("Папка удалится со всех ваших устройств. Сами чаты останутся.")
        }
        .accessibilityIdentifier("chat-folders-settings-screen")
    }

    private func moveFolders(from source: IndexSet, to destination: Int) {
        var reordered = store.folders
        reordered.move(fromOffsets: source, toOffset: destination)
        store.reorder(folderIDs: reordered.map(\.id))
    }

    private func recommendation(
        title: String,
        detail: String,
        symbol: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(LuxoraTheme.iris)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Добавить", action: action)
                .buttonStyle(.bordered)
                .disabled(store.mutationState == .loading)
                .accessibilityIdentifier("chat-folder-recommend-\(title)")
        }
    }

    private func folderSettingsRow(_ folder: ChatFolder) -> some View {
        let identifier = "chat-folder-settings-\(folder.id.apiPathComponent)"
        let count = folder.projectedConversations(conversations).count
        return Button {
            editor = .edit(folder)
        } label: {
            PhoneChatFolderSettingsRow(
                symbol: "folder.fill",
                color: color(for: folder),
                title: folder.title,
                detail: folderDetail(folder),
                count: count,
                isSelected: store.selectedFolderID == folder.id
            )
        }
        .buttonStyle(.plain)
        .accessibilityHint("Открывает правила и отдельные чаты этой папки")
        .accessibilityValue(store.selectedFolderID == folder.id ? "Выбрано" : "")
        .accessibilityAddTraits(store.selectedFolderID == folder.id ? .isSelected : [])
        .accessibilityIdentifier(identifier)
        .swipeActions {
            Button("Удалить", role: .destructive) {
                deletionCandidate = folder
            }
        }
    }

    private func folderDetail(_ folder: ChatFolder) -> String {
        var parts: [String] = []
        if folder.rules.unreadOnly { parts.append("непрочитанные") }
        if folder.rules.excludeMuted { parts.append("кроме чатов без звука") }
        if folder.rules.includeArchived { parts.append("с архивом") }
        if parts.isEmpty {
            parts = folder.rules.includeKinds.map(\.russianTitle)
        }
        return parts.isEmpty ? "Только выбранные чаты" : parts.joined(separator: " · ")
    }

    private func color(for folder: ChatFolder) -> Color {
        let palette: [Color] = [
            LuxoraTheme.iris, .orange, .cyan, .green, .pink, .indigo, .teal,
        ]
        let index = folder.id.uuidString.utf8.reduce(0) { partial, byte in
            (partial * 31 + Int(byte)) % palette.count
        }
        return palette[index]
    }
}

private struct PhoneChatFolderSynchronizationSection: View {
    let folderCountSummary: String

    var body: some View {
        Section {
            LabeledContent("Синхронизация", value: "Сервер Luxora")
            LabeledContent("Папок", value: folderCountSummary)
            Text(
                "Изменения появляются только после подтверждения сервера. "
                    + "Точный повтор одной команды действует 24 часа; после перезапуска "
                    + "приложения незавершённая команда пока не восстанавливается."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

enum FolderEditorDestination: Identifiable {
    case create
    case edit(ChatFolder)

    var id: String {
        switch self {
        case .create: "create"
        case let .edit(folder): folder.id.apiPathComponent
        }
    }
}

private struct PhoneChatFolderEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: ChatFoldersStore
    let conversations: [Conversation]
    let destination: FolderEditorDestination

    @State private var draft: ChatFolderDraft
    @State private var didSubmit = false
    @State private var localValidationMessage: String?

    init(
        store: ChatFoldersStore,
        conversations: [Conversation],
        destination: FolderEditorDestination
    ) {
        self.store = store
        self.conversations = conversations
        self.destination = destination
        switch destination {
        case .create:
            _draft = State(initialValue: .empty)
        case let .edit(folder):
            _draft = State(initialValue: ChatFolderDraft(
                title: folder.title,
                rules: folder.rules,
                overrides: folder.overrides
            ))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Название") {
                    TextField("Название папки", text: $draft.title)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("chat-folder-title")
                    Text(titleCountSummary)
                        .font(.caption)
                        .foregroundStyle(titleIsValid ? Color.secondary : Color.red)
                }

                Section("Типы чатов") {
                    ForEach(ChatFolderChatKind.allCases) { kind in
                        Toggle(kind.russianTitle, isOn: kindBinding(kind))
                            .accessibilityIdentifier("chat-folder-kind-\(kind.rawValue)")
                    }
                    Text("Если выключить все типы, папка будет состоять только из чатов, добавленных вручную.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Условия") {
                    Toggle("Только непрочитанные", isOn: $draft.rules.unreadOnly)
                        .accessibilityIdentifier("chat-folder-unread-only")
                    Toggle("Исключить чаты без звука", isOn: $draft.rules.excludeMuted)
                        .accessibilityIdentifier("chat-folder-exclude-muted")
                    Toggle("Показывать архив", isOn: $draft.rules.includeArchived)
                        .accessibilityIdentifier("chat-folder-include-archived")
                }

                Section {
                    ForEach(conversations.sorted(by: { $0.title < $1.title })) { conversation in
                        HStack(spacing: 11) {
                            AvatarView(participant: conversation.avatar, size: 38)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(conversation.title)
                                    .lineLimit(1)
                                Text(ruleLabel(for: conversation.id))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            Menu {
                                Button("По правилам") {
                                    setOverride(.automatic, chatID: conversation.id)
                                }
                                Button("Всегда включать") {
                                    setOverride(.include, chatID: conversation.id)
                                }
                                Button("Включить и закрепить") {
                                    setOverride(.pinned, chatID: conversation.id)
                                }
                                Button("Исключить") {
                                    setOverride(.exclude, chatID: conversation.id)
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .font(.title3)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Правило для \(conversation.title)")
                            .accessibilityIdentifier(
                                "chat-folder-chat-mode-\(conversation.id.apiPathComponent)"
                            )
                        }
                    }
                } header: {
                    Text("Отдельные чаты")
                } footer: {
                    Text("Настроено \(draft.overrides.count) из \(ChatFolderContract.maximumOverrides). Явное исключение всегда скрывает чат; явное включение всегда показывает его. Закреплённые идут первыми по позиции, остальные сохраняют порядок списка чатов. Это клиентское правило Beta-0.1.")
                }

                if let localValidationMessage {
                    Section {
                        Label(localValidationMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("chat-folder-local-validation")
                    }
                }

                if let failure = store.mutationFailure {
                    Section {
                        PhoneChatFolderMutationFailureView(failure: failure, store: store)
                    }
                }
            }
            .navigationTitle(isCreating ? "Новая папка" : "Изменить папку")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(store.mutationState == .loading ? "Сохраняем…" : "Готово") {
                        didSubmit = true
                        switch destination {
                        case .create:
                            store.create(draft)
                        case let .edit(folder):
                            store.update(
                                folderID: folder.id,
                                draft: draft,
                                expectedRevision: folder.revision
                            )
                        }
                    }
                    .disabled(!titleIsValid || store.mutationState == .loading)
                    .accessibilityIdentifier("chat-folder-save")
                }
            }
            .onChange(of: draft.title) { _, value in
                if value.unicodeScalars.count > ChatFolderContract.maximumTitleCodePoints {
                    draft.title = String(
                        value.unicodeScalars.prefix(ChatFolderContract.maximumTitleCodePoints)
                    )
                }
            }
            .onChange(of: store.mutationState) { _, state in
                if didSubmit, state == .loaded { dismiss() }
            }
            .accessibilityIdentifier("chat-folder-editor-screen")
        }
    }

    private var isCreating: Bool {
        if case .create = destination { return true }
        return false
    }

    private var titleIsValid: Bool {
        let normalized = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty
            && normalized.unicodeScalars.count <= ChatFolderContract.maximumTitleCodePoints
    }

    private var titleCountSummary: String {
        "\(draft.title.unicodeScalars.count) из \(ChatFolderContract.maximumTitleCodePoints)"
    }

    private func kindBinding(_ kind: ChatFolderChatKind) -> Binding<Bool> {
        Binding(
            get: { draft.rules.includeKinds.contains(kind) },
            set: { isIncluded in
                if isIncluded {
                    if !draft.rules.includeKinds.contains(kind) {
                        draft.rules.includeKinds.append(kind)
                    }
                } else {
                    draft.rules.includeKinds.removeAll(where: { $0 == kind })
                }
            }
        )
    }

    private func ruleLabel(for chatID: UUID) -> String {
        guard let override = draft.overrides.first(where: { $0.chatID == chatID }) else {
            return "По правилам папки"
        }
        return switch (override.mode, override.pinnedPosition) {
        case (.include, .some): "Включён и закреплён"
        case (.include, .none): "Всегда включён"
        case (.exclude, _): "Исключён"
        }
    }

    private func setOverride(_ mode: EditorChatRule, chatID: UUID) {
        let hadOverride = draft.overrides.contains(where: { $0.chatID == chatID })
        if mode != .automatic,
           !hadOverride,
           draft.overrides.count >= ChatFolderContract.maximumOverrides {
            localValidationMessage = "В одной папке можно настроить не больше \(ChatFolderContract.maximumOverrides) отдельных чатов. Верните один чат к правилам папки, чтобы добавить другой."
            return
        }
        localValidationMessage = nil
        draft.overrides.removeAll(where: { $0.chatID == chatID })
        switch mode {
        case .automatic:
            normalizePinPositions()
        case .include:
            draft.overrides.append(
                ChatFolderOverride(chatID: chatID, mode: .include, pinnedPosition: nil)
            )
        case .pinned:
            let next = (draft.overrides.compactMap(\.pinnedPosition).max() ?? -1) + 1
            draft.overrides.append(
                ChatFolderOverride(
                    chatID: chatID,
                    mode: .include,
                    pinnedPosition: min(next, 99)
                )
            )
            normalizePinPositions()
        case .exclude:
            draft.overrides.append(
                ChatFolderOverride(chatID: chatID, mode: .exclude, pinnedPosition: nil)
            )
            normalizePinPositions()
        }
    }

    private func normalizePinPositions() {
        let pinnedIDs = draft.overrides
            .filter { $0.mode == .include && $0.pinnedPosition != nil }
            .sorted { $0.pinnedPosition! < $1.pinnedPosition! }
            .map(\.chatID)
        for index in draft.overrides.indices {
            if let position = pinnedIDs.firstIndex(of: draft.overrides[index].chatID) {
                draft.overrides[index].pinnedPosition = position
            }
        }
    }
}

private enum EditorChatRule: Equatable {
    case automatic
    case include
    case pinned
    case exclude
}

private struct PhoneChatFolderSettingsRow: View {
    let symbol: String
    let color: Color
    let title: String
    let detail: String
    let count: Int
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(color.gradient, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 6)
            Text("\(count)")
                .foregroundStyle(.secondary)
            Image(systemName: isSelected ? "checkmark.circle.fill" : "chevron.right")
                .font(isSelected ? .body.weight(.semibold) : .caption.weight(.semibold))
                .foregroundStyle(isSelected ? LuxoraTheme.iris : Color.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), чатов: \(count), \(detail)")
    }
}

private struct PhoneChatFolderActionRow: View {
    let symbol: String
    let color: Color
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(color.gradient, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneChatFolderFailureRow: View {
    let title: String
    let detail: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "wifi.exclamationmark")
                .font(.headline)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Повторить", action: retry)
                .buttonStyle(.bordered)
        }
    }
}

private struct PhoneChatFolderMutationFailureView: View {
    let failure: ChatFolderMutationFailure
    @Bindable var store: ChatFoldersStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("\(failure.kind.russianTitle) не выполнено", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(failure.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                if failure.supportsExactRetry || failure.requiresReviewAfterRefresh {
                    Button(
                        failure.requiresReviewAfterRefresh ? "Проверить и повторить" : "Повторить точно",
                        action: store.retryLastMutation
                    )
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("chat-folder-retry")
                }
                Button("Закрыть", action: store.dismissMutationFailure)
                    .buttonStyle(.bordered)
            }
        }
        .accessibilityIdentifier("chat-folder-mutation-failure")
    }
}
#endif

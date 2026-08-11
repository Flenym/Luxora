#if os(iOS)
import SwiftUI

enum PhoneCommunityScope: String, CaseIterable, Identifiable {
    case all = "Все"
    case groups = "Группы"
    case channels = "Каналы"

    var id: String { rawValue }
}

private func communityCountLabel(_ count: Int, kind: ConversationKind) -> String {
    let singular = kind == .channel ? "подписчик" : "участник"
    let paucal = kind == .channel ? "подписчика" : "участника"
    let plural = kind == .channel ? "подписчиков" : "участников"
    let lastTwo = abs(count) % 100
    let last = abs(count) % 10
    let noun: String
    if 11...14 ~= lastTwo {
        noun = plural
    } else if last == 1 {
        noun = singular
    } else if 2...4 ~= last {
        noun = paucal
    } else {
        noun = plural
    }
    return "\(count) \(noun)"
}

struct PhoneCommunitiesView: View {
    @Bindable var communityStore: CommunityStore
    let communityListState: RemoteContentState
    let refreshCommunities: () async -> Void
    let openConversation: (UUID) -> Void
    let acceptCreatedCommunity: (Conversation) -> Void

    @State private var scope: PhoneCommunityScope = .all
    @State private var query = ""
    @State private var creationKind: CommunityKind?

    private var communities: [Conversation] {
        communityStore.communities.filter { conversation in
            let matchesScope: Bool
            switch scope {
            case .all: matchesScope = true
            case .groups: matchesScope = conversation.kind == .group
            case .channels: matchesScope = conversation.kind == .channel
            }
            let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
            return matchesScope && (
                normalized.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(normalized)
                    || conversation.subtitle.localizedCaseInsensitiveContains(normalized)
            )
        }
    }

    var body: some View {
        List {
            Section {
                Picker("Тип", selection: $scope) {
                    ForEach(PhoneCommunityScope.allCases) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("spaces-scope")
            }
            .listRowBackground(Color.clear)

            if case let .failed(detail) = communityListState {
                Section {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "wifi.exclamationmark")
                            .foregroundStyle(.red)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(communities.isEmpty ? "Не удалось загрузить сообщества" : "Не удалось обновить сообщества")
                                .font(.subheadline.weight(.semibold))
                            Text(detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Button("Повторить") {
                            Task { await refreshCommunities() }
                        }
                        .font(.caption.weight(.semibold))
                        .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("spaces-load-failed")
                }
            }

            if communityListState == .loading, communities.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Загружаем группы и каналы…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 72)
                    .accessibilityIdentifier("spaces-loading")
                }
            } else if communities.isEmpty {
                if !isUnloadedFailure {
                    Section {
                        ContentUnavailableView {
                            Label(emptyTitle, systemImage: emptySymbol)
                        } description: {
                            Text(emptyDetail)
                        } actions: {
                            if query.isEmpty {
                                Button("Создать", systemImage: "plus") {
                                    creationKind = scope == .channels ? .channel : .group
                                }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("spaces-empty-create")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("spaces-empty")
                    }
                }
            } else {
                Section(communitySectionTitle) {
                    ForEach(communities) { conversation in
                        Button {
                            openConversation(conversation.id)
                        } label: {
                            PhoneCommunityRow(conversation: conversation)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("spaces-community-\(conversation.id.uuidString.lowercased())")
                    }
                }
            }

            Section {
                Label("Группы и каналы хранят состав, роли и сообщения на сервере Luxora.", systemImage: "checkmark.shield.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("spaces-server-confirmed-note")
            }
        }
        .navigationTitle("Группы и каналы")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: "Поиск")
        .refreshable { await refreshCommunities() }
        .task {
            if communityListState == .idle {
                await refreshCommunities()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Создать группу", systemImage: "person.2.fill") {
                        creationKind = .group
                    }
                    Button("Создать канал", systemImage: "megaphone.fill") {
                        creationKind = .channel
                    }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("Создать группу или канал")
                .accessibilityIdentifier("spaces-create")
            }
        }
        .sheet(item: $creationKind) { kind in
            PhoneCommunityCreateSheet(
                communityStore: communityStore,
                initialKind: kind,
                created: { conversation in
                    acceptCreatedCommunity(conversation)
                    creationKind = nil
                    openConversation(conversation.id)
                }
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spaces-screen")
    }

    private var communitySectionTitle: String {
        switch scope {
        case .all: "Ваши сообщества"
        case .groups: "Ваши группы"
        case .channels: "Ваши каналы"
        }
    }

    private var emptyTitle: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Ничего не найдено"
        }
        switch scope {
        case .all:
            return "Групп и каналов пока нет"
        case .groups:
            return "Групп пока нет"
        case .channels:
            return "Каналов пока нет"
        }
    }

    private var emptyDetail: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Измените запрос или область поиска."
        }
        return "Создайте сообщество и добавьте подтверждённые контакты по username."
    }

    private var emptySymbol: String {
        scope == .channels ? "megaphone" : "person.3"
    }

    private var isUnloadedFailure: Bool {
        if case .failed = communityListState { return communities.isEmpty }
        return false
    }
}

private struct PhoneCommunityRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(participant: conversation.avatar, size: 50)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: conversation.kind == .channel ? "megaphone.fill" : "person.2.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(LuxoraTheme.iris, in: Circle())
                        .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(conversation.title), \(summary)")
    }

    private var summary: String {
        "\(communityCountLabel(conversation.memberCount, kind: conversation.kind)) · \(roleTitle)"
    }

    private var roleTitle: String {
        conversation.serverRole
            .flatMap(ChatMembershipRole.init(rawValue:))?
            .russianTitle.lowercased() ?? "роль уточняется"
    }
}

private struct PhoneCommunityCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var communityStore: CommunityStore
    let initialKind: CommunityKind
    let created: (Conversation) -> Void

    @State private var kind: CommunityKind
    @State private var title = ""
    @State private var username = ""
    @State private var selectedMembers: [Participant] = []

    init(
        communityStore: CommunityStore,
        initialKind: CommunityKind,
        created: @escaping (Conversation) -> Void
    ) {
        self.communityStore = communityStore
        self.initialKind = initialKind
        self.created = created
        _kind = State(initialValue: initialKind)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Тип сообщества") {
                    Picker("Тип", selection: $kind) {
                        Label("Группа", systemImage: "person.2.fill").tag(CommunityKind.group)
                        Label("Канал", systemImage: "megaphone.fill").tag(CommunityKind.channel)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("community-create-kind")
                }

                Section("Название") {
                    TextField(kind == .group ? "Название группы" : "Название канала", text: $title)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("community-create-title")
                    Text("\(title.trimmingCharacters(in: .whitespacesAndNewlines).count)/120")
                        .font(.caption)
                        .foregroundStyle(titleCountIsValid ? Color.secondary : Color.red)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }

                Section {
                    TextField("@username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("community-create-username")

                    lookupContent
                } header: {
                    Text(kind == .channel ? "Добавить подписчиков" : "Добавить участников")
                } footer: {
                    Text("Можно пропустить: новых \(kind == .channel ? "подписчиков" : "участников") владелец добавит позже. Поиск выполняется по точному username.")
                }

                if !selectedMembers.isEmpty {
                    Section("Выбрано: \(selectedMembers.count)") {
                        ForEach(selectedMembers) { participant in
                            HStack(spacing: 12) {
                                AvatarView(participant: participant, size: 38)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(participant.displayName)
                                    Text("@\(participant.username)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(role: .destructive) {
                                    selectedMembers.removeAll { $0.id == participant.id }
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                }
                                .buttonStyle(.plain)
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityLabel("Убрать \(participant.displayName)")
                            }
                        }
                    }
                }

                if let creationError = communityStore.creationError {
                    Section {
                        PhoneCommunityCreationFailure(
                            certainty: communityStore.creationCertainty,
                            detail: creationError,
                            retry: retryCreation
                        )
                    }
                }
            }
            .navigationTitle(kind == .group ? "Новая группа" : "Новый канал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(communityStore.creationState == .loading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Создать") { submit() }
                        .fontWeight(.semibold)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("community-create-submit")
                }
            }
            .overlay {
                if communityStore.creationState == .loading {
                    ZStack {
                        Color.black.opacity(0.12).ignoresSafeArea()
                        ProgressView("Создаём на сервере…")
                            .padding(20)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .accessibilityIdentifier("community-create-loading")
                }
            }
            .task(id: normalizedUsername) {
                guard !normalizedUsername.isEmpty else {
                    communityStore.clearLookup()
                    return
                }
                do {
                    try await Task.sleep(for: .milliseconds(350))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await communityStore.lookupMemberCandidate(normalizedUsername)
            }
            .onAppear {
                communityStore.clearCreationResult()
                communityStore.clearLookup()
            }
            .accessibilityIdentifier("community-create-screen")
        }
    }

    @ViewBuilder
    private var lookupContent: some View {
        switch communityStore.lookupState {
        case .idle:
            if !normalizedUsername.isEmpty {
                Text("Введите username полностью.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Ищем на сервере…")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("community-create-lookup-loading")
        case .loaded:
            if let participant = communityStore.lookupResult {
                HStack(spacing: 12) {
                    AvatarView(participant: participant, size: 42)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(participant.displayName)
                        Text("@\(participant.username)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedMembers.contains(where: { $0.id == participant.id }) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .accessibilityLabel("Уже добавлен")
                    } else {
                        Button("Добавить") {
                            selectedMembers.append(participant)
                            username = ""
                            communityStore.clearLookup()
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("community-create-add-result")
                    }
                }
                .accessibilityIdentifier("community-create-lookup-result")
            } else {
                Label("Пользователь с таким username не найден", systemImage: "person.crop.circle.badge.questionmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("community-create-lookup-empty")
            }
        case let .failed(detail):
            VStack(alignment: .leading, spacing: 8) {
                Label("Поиск не выполнен", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.red)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Повторить") {
                    Task { await communityStore.lookupMemberCandidate(normalizedUsername) }
                }
            }
            .accessibilityIdentifier("community-create-lookup-failed")
        }
    }

    private var normalizedUsername: String {
        username.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
    }

    private var titleCountIsValid: Bool {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty && normalized.count <= 120
    }

    private var canSubmit: Bool {
        titleCountIsValid
            && selectedMembers.count <= 199
            && communityStore.creationState != .loading
            && communityStore.creationCertainty != .outcomeUnknown
    }

    private func submit() {
        Task {
            if let conversation = await communityStore.createCommunity(
                kind: kind,
                title: title,
                memberIDs: selectedMembers.map(\.id)
            ) {
                created(conversation)
                dismiss()
            }
        }
    }

    private func retryCreation() {
        Task {
            if let conversation = await communityStore.retryCommunityCreation() {
                created(conversation)
                dismiss()
            }
        }
    }
}

private struct PhoneCommunityCreationFailure: View {
    let certainty: CommunityCreationCertainty
    let detail: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: certainty == .outcomeUnknown ? "exclamationmark.triangle.fill" : "xmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(certainty == .outcomeUnknown ? .orange : .red)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if certainty == .definitivelyRejected {
                Button("Повторить тот же запрос", action: retry)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("community-create-retry")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("community-create-failure")
    }

    private var title: String {
        certainty == .outcomeUnknown
            ? "Результат нужно проверить"
            : "Сервер не создал сообщество"
    }
}

struct PhoneCommunityProfileView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var communityStore: CommunityStore
    let initialConversation: Conversation
    let openConversation: (UUID) -> Void
    let leftCommunity: (UUID) -> Void

    @State private var showsAddMember = false
    @State private var leaveCandidate: CommunityMember?
    @State private var unavailableProfileTab: PhoneCommunityProfileTab?
    @State private var memberQuery = ""
    @State private var isMemberSearchPresented = false

    private var conversation: Conversation {
        communityStore.community(initialConversation.id) ?? initialConversation
    }

    private var confirmedMembers: [CommunityMember] {
        communityStore.members(conversation.id)
    }

    private var members: [CommunityMember] {
        let normalized = memberQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return confirmedMembers }
        return confirmedMembers.filter { member in
            member.participant.displayName.localizedCaseInsensitiveContains(normalized)
                || member.participant.username.localizedCaseInsensitiveContains(normalized)
        }
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    AvatarView(participant: conversation.avatar, size: 104)
                    Text(conversation.title)
                        .font(.title.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(profileSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    quickActions
                        .padding(.top, 8)

                    profileTabs
                        .padding(.top, 4)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .accessibilityIdentifier("community-profile-header")
            }
            .listRowBackground(Color.clear)
            .listRowInsets(.init(top: 0, leading: 12, bottom: 4, trailing: 12))

            if let failure = firstMutationFailure {
                Section {
                    PhoneCommunityMutationFailureView(
                        failure: failure,
                        state: communityStore.mutationState(failure.key),
                        retry: {
                            Task { _ = await communityStore.retryMutation(failure.key) }
                        },
                        dismiss: { communityStore.clearMutationFailure(failure.key) }
                    )
                }
            }

            memberSection

            if let currentMember,
               currentMember.membership.role != .owner {
                Section {
                    Button("Покинуть \(conversation.kind == .channel ? "канал" : "группу")", role: .destructive) {
                        leaveCandidate = currentMember
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityIdentifier("community-leave")
                } footer: {
                    Text("Доступ к истории и новым сообщениям будет закрыт после подтверждения сервером.")
                }
            }
        }
        .navigationTitle("Информация")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $memberQuery,
            isPresented: $isMemberSearchPresented,
            prompt: conversation.kind == .channel ? "Поиск подписчиков" : "Поиск участников"
        )
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if communityStore.canAddMember(role: .member, to: conversation.id) {
                    Button("Добавить", systemImage: "person.badge.plus") {
                        showsAddMember = true
                    }
                    .accessibilityIdentifier("community-add-member")
                }
            }
        }
        .task(id: conversation.id) {
            await communityStore.refreshCommunity(conversation.id)
            await communityStore.loadMembers(conversation.id)
        }
        .refreshable {
            await communityStore.refreshCommunity(conversation.id)
            await communityStore.loadMembers(conversation.id, force: true)
        }
        .sheet(isPresented: $showsAddMember) {
            PhoneCommunityAddMemberSheet(
                communityStore: communityStore,
                conversation: conversation
            )
        }
        .confirmationDialog(
            "Покинуть \(conversation.kind == .channel ? "канал" : "группу")?",
            isPresented: Binding(
                get: { leaveCandidate != nil },
                set: { if !$0 { leaveCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let leaveCandidate {
                Button("Покинуть", role: .destructive) {
                    Task {
                        if await communityStore.removeMember(leaveCandidate.id, from: conversation.id) {
                            leftCommunity(conversation.id)
                        }
                        self.leaveCandidate = nil
                    }
                }
            }
            Button("Отмена", role: .cancel) { leaveCandidate = nil }
        } message: {
            Text("Luxora выполнит выход только после подтверждения сервером.")
        }
        .alert(item: $unavailableProfileTab) { tab in
            Alert(
                title: Text("\(tab.russianTitle) пока недоступны"),
                message: Text("Этот раздел появится после подключения серверного каталога вложений. Состав и роли уже работают в Beta-0.1."),
                dismissButton: .default(Text("Понятно"))
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("community-profile-screen")
    }

    private var quickActions: some View {
        LazyVGrid(columns: quickActionColumns, spacing: 8) {
            PhoneCommunityQuickAction(
                title: conversation.kind == .channel ? "Канал" : "Чат",
                symbol: "bubble.left.fill",
                action: { openConversation(conversation.id) }
            )

            PhoneCommunityQuickAction(
                title: "Поиск",
                symbol: "magnifyingglass",
                action: { isMemberSearchPresented = true }
            )

            if let currentMember,
               currentMember.membership.role != .owner {
                PhoneCommunityQuickAction(
                    title: "Покинуть",
                    symbol: "rectangle.portrait.and.arrow.right",
                    tint: .red,
                    action: { leaveCandidate = currentMember }
                )
            } else if communityStore.canAddMember(role: .member, to: conversation.id) {
                PhoneCommunityQuickAction(
                    title: "Добавить",
                    symbol: "person.badge.plus",
                    action: { showsAddMember = true }
                )
            } else {
                PhoneCommunityQuickAction(
                    title: memberListTitle,
                    symbol: conversation.kind == .channel ? "person.2.fill" : "person.3.fill",
                    action: refreshMembers
                )
            }

            Menu {
                Button("Обновить с сервера", systemImage: "arrow.clockwise", action: refreshProfile)
                if communityStore.canAddMember(role: .member, to: conversation.id) {
                    Button("Добавить \(conversation.kind == .channel ? "подписчика" : "участника")", systemImage: "person.badge.plus") {
                        showsAddMember = true
                    }
                }
                if let currentMember,
                   currentMember.membership.role != .owner {
                    Button("Покинуть \(conversation.kind == .channel ? "канал" : "группу")", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        leaveCandidate = currentMember
                    }
                }
            } label: {
                PhoneCommunityQuickActionLabel(title: "Ещё", symbol: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Другие действия")
            .accessibilityIdentifier("community-profile-more")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("community-profile-actions")
    }

    private var profileTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(PhoneCommunityProfileTab.allCases) { tab in
                    Button {
                        if tab != .members {
                            unavailableProfileTab = tab
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(tab.title(for: conversation.kind))
                            if tab != .members {
                                Image(systemName: "lock.fill")
                                    .font(.system(size: 8, weight: .bold))
                            }
                        }
                        .font(.subheadline.weight(tab == .members ? .semibold : .regular))
                        .foregroundStyle(tab == .members ? .primary : .secondary)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background {
                            if tab == .members {
                                Capsule().fill(Color.secondary.opacity(0.2))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab == .members ? .isSelected : [])
                    .accessibilityHint(tab == .members ? "Показан текущий раздел" : "Показывает статус функции Beta-0.1")
                    .accessibilityIdentifier("community-profile-tab-\(tab.rawValue)")
                }
            }
            .padding(4)
        }
        .background(Color.secondary.opacity(0.1), in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.18), lineWidth: 0.5))
        .clipShape(Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Разделы профиля")
        .accessibilityIdentifier("community-profile-tabs")
    }

    @ViewBuilder
    private var memberSection: some View {
        switch communityStore.memberListState(conversation.id) {
        case .idle where members.isEmpty, .loading where members.isEmpty:
            Section(memberListTitle) {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Загружаем \(memberListTitle.lowercased())…")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 64)
                .accessibilityIdentifier("community-members-loading")
            }
        case let .failed(detail) where members.isEmpty:
            Section(memberListTitle) {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Не удалось загрузить \(memberListTitle.lowercased())", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await communityStore.loadMembers(conversation.id, force: true) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .accessibilityIdentifier("community-members-failed")
            }
        default:
            Section("\(memberListTitle) · \(members.count)") {
                if communityStore.canAddMember(role: .member, to: conversation.id) {
                    Button {
                        showsAddMember = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "person.badge.plus")
                                .font(.title3)
                                .foregroundStyle(LuxoraTheme.electricBlue)
                                .frame(width: 44, height: 44)
                            Text(conversation.kind == .channel ? "Добавить подписчика" : "Добавить участника")
                                .foregroundStyle(LuxoraTheme.electricBlue)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("community-members-inline-add")
                }
                if case let .failed(detail) = communityStore.memberListState(conversation.id) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Не удалось обновить список")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.red)
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Повторить") {
                            Task { await communityStore.loadMembers(conversation.id, force: true) }
                        }
                    }
                    .accessibilityIdentifier("community-members-refresh-failed")
                }
                if members.isEmpty, !memberQuery.isEmpty {
                    ContentUnavailableView.search(text: memberQuery)
                        .accessibilityIdentifier("community-members-search-empty")
                } else {
                    ForEach(members) { member in
                        PhoneCommunityMemberRow(
                            communityStore: communityStore,
                            conversation: conversation,
                            member: member
                        )
                    }
                }
            }
        }
    }

    private var profileSubtitle: String {
        let role = localizedRole(
            communityStore.currentUserRole(in: conversation.id)
                ?? conversation.serverRole.flatMap(ChatMembershipRole.init(rawValue:))
        )
        return "\(communityCountLabel(conversation.memberCount, kind: conversation.kind)) · \(role)"
    }

    private var currentMember: CommunityMember? {
        confirmedMembers.first { $0.id == communityStore.currentUserID }
    }

    private var memberListTitle: String {
        conversation.kind == .channel ? "Подписчики" : "Участники"
    }

    private var quickActionColumns: [GridItem] {
        Array(
            repeating: GridItem(.flexible(), spacing: 8),
            count: dynamicTypeSize >= .xxLarge ? 2 : 4
        )
    }

    private func localizedRole(_ role: ChatMembershipRole?) -> String {
        guard let role else { return "роль уточняется" }
        if conversation.kind == .channel, role == .member {
            return "подписчик"
        }
        return role.russianTitle.lowercased()
    }

    private func refreshProfile() {
        Task {
            await communityStore.refreshCommunity(conversation.id)
            await communityStore.loadMembers(conversation.id, force: true)
        }
    }

    private func refreshMembers() {
        Task { await communityStore.loadMembers(conversation.id, force: true) }
    }

    private var firstMutationFailure: CommunityMemberMutationFailure? {
        communityStore.mutationFailures.values
            .filter { $0.key.chatID == conversation.id }
            .sorted { lhs, rhs in
                if lhs.key.kind.rawValue != rhs.key.kind.rawValue {
                    return lhs.key.kind.rawValue < rhs.key.kind.rawValue
                }
                return lhs.key.userID.uuidString < rhs.key.userID.uuidString
            }
            .first
    }
}

private struct PhoneCommunityMemberRow: View {
    @Bindable var communityStore: CommunityStore
    let conversation: Conversation
    let member: CommunityMember

    @State private var removalConfirmation = false

    private var roleChangeKey: CommunityMemberMutationKey {
        CommunityMemberMutationKey(
            chatID: conversation.id,
            userID: member.id,
            kind: .changeRole
        )
    }

    private var removalKey: CommunityMemberMutationKey {
        CommunityMemberMutationKey(
            chatID: conversation.id,
            userID: member.id,
            kind: .remove
        )
    }

    private var isWorking: Bool {
        communityStore.mutationState(roleChangeKey) == .loading
            || communityStore.mutationState(removalKey) == .loading
    }

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(participant: member.participant, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(member.participant.displayName)
                        .font(.body.weight(.medium))
                    if member.id == communityStore.currentUserID {
                        Text("вы")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(memberStatus)
                    .font(.caption)
                    .foregroundStyle(member.participant.isOnline ? LuxoraTheme.electricBlue : .secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            if isWorking {
                ProgressView()
            } else {
                Text(localizedRoleTitle)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(roleColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(roleColor.opacity(0.12), in: Capsule())
            }
            if showsMenu {
                Menu {
                    if communityStore.canChangeRole(
                        of: member.id,
                        to: alternateRole,
                        in: conversation.id
                    ) {
                        Button(roleChangeTitle, systemImage: roleChangeSymbol) {
                            Task {
                                _ = await communityStore.changeRole(
                                    of: member.id,
                                    to: alternateRole,
                                    in: conversation.id
                                )
                            }
                        }
                    }
                    if communityStore.canRemoveMember(member.id, from: conversation.id),
                       member.id != communityStore.currentUserID {
                        Button("Удалить", systemImage: "person.fill.xmark", role: .destructive) {
                            removalConfirmation = true
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                }
                .disabled(isWorking)
                .accessibilityLabel("Действия с \(member.participant.displayName)")
            }
        }
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .confirmationDialog(
            "Удалить \(member.participant.displayName)?",
            isPresented: $removalConfirmation,
            titleVisibility: .visible
        ) {
            Button("Удалить", role: .destructive) {
                Task {
                    _ = await communityStore.removeMember(member.id, from: conversation.id)
                }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("\(conversation.kind == .channel ? "Подписчик" : "Участник") потеряет доступ после подтверждения сервером.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(member.participant.displayName), \(memberStatus), \(localizedRoleTitle)")
        .accessibilityIdentifier("community-member-\(member.id.uuidString.lowercased())")
    }

    private var memberStatus: String {
        if member.participant.isOnline { return "в сети" }
        let status = member.participant.status.trimmingCharacters(in: .whitespacesAndNewlines)
        if status.isEmpty || status == "@\(member.participant.username)" {
            return "@\(member.participant.username)"
        }
        return status
    }

    private var localizedRoleTitle: String {
        if conversation.kind == .channel, member.membership.role == .member {
            return "Подписчик"
        }
        return member.membership.role.russianTitle
    }

    private var alternateRole: ChatMembershipRole {
        member.membership.role == .admin ? .member : .admin
    }

    private var roleChangeTitle: String {
        alternateRole == .admin ? "Назначить администратором" : "Снять администратора"
    }

    private var roleChangeSymbol: String {
        alternateRole == .admin ? "star.fill" : "star.slash"
    }

    private var showsMenu: Bool {
        communityStore.canChangeRole(of: member.id, to: alternateRole, in: conversation.id)
            || (
                member.id != communityStore.currentUserID
                    && communityStore.canRemoveMember(member.id, from: conversation.id)
            )
    }

    private var roleColor: Color {
        member.membership.role.isPrivileged ? LuxoraTheme.iris : .secondary
    }
}

private enum PhoneCommunityProfileTab: String, CaseIterable, Identifiable {
    case members
    case media
    case files
    case voice
    case links
    case gifs

    var id: String { rawValue }

    var russianTitle: String {
        switch self {
        case .members: "Участники"
        case .media: "Медиа"
        case .files: "Файлы"
        case .voice: "Голос"
        case .links: "Ссылки"
        case .gifs: "GIF"
        }
    }

    func title(for kind: ConversationKind) -> String {
        if self == .members, kind == .channel { return "Подписчики" }
        return russianTitle
    }
}

private struct PhoneCommunityQuickAction: View {
    let title: String
    let symbol: String
    var tint: Color = LuxoraTheme.electricBlue
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            PhoneCommunityQuickActionLabel(title: title, symbol: symbol, tint: tint)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityIdentifier("community-profile-action-\(title.lowercased())")
    }
}

private struct PhoneCommunityQuickActionLabel: View {
    let title: String
    let symbol: String
    var tint: Color = LuxoraTheme.electricBlue

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.title3.weight(.medium))
                .foregroundStyle(tint)
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(tint)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 76)
        .padding(.horizontal, 4)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct PhoneCommunityAddMemberSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var communityStore: CommunityStore
    let conversation: Conversation

    @State private var username = ""
    @State private var selectedRole: ChatMembershipRole = .member

    private var normalizedUsername: String {
        username.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("@username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("community-add-username")
                } header: {
                    Text("Точный username")
                } footer: {
                    Text("Добавить можно только пользователя, с которым сервер разрешает связь.")
                }

                Section {
                    addLookupContent
                }

                if communityStore.currentUserRole(in: conversation.id) == .owner {
                    Section("Роль") {
                        Picker("Роль", selection: $selectedRole) {
                            Text(conversation.kind == .channel ? "Подписчик" : "Участник")
                                .tag(ChatMembershipRole.member)
                            Text("Администратор").tag(ChatMembershipRole.admin)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("community-add-role")
                    }
                }

                if let failure = addFailure {
                    Section {
                        PhoneCommunityMutationFailureView(
                            failure: failure,
                            state: communityStore.mutationState(failure.key),
                            retry: {
                                Task {
                                    if await communityStore.retryMutation(failure.key) {
                                        dismiss()
                                    }
                                }
                            },
                            dismiss: { communityStore.clearMutationFailure(failure.key) }
                        )
                    }
                }
            }
            .navigationTitle(conversation.kind == .channel ? "Добавить подписчика" : "Добавить участника")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
            .task(id: normalizedUsername) {
                guard !normalizedUsername.isEmpty else {
                    communityStore.clearLookup()
                    return
                }
                do {
                    try await Task.sleep(for: .milliseconds(350))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await communityStore.lookupMemberCandidate(normalizedUsername)
            }
            .onAppear { communityStore.clearLookup() }
            .accessibilityIdentifier("community-add-screen")
        }
    }

    @ViewBuilder
    private var addLookupContent: some View {
        switch communityStore.lookupState {
        case .idle:
            Text("Введите username полностью.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Ищем на сервере…")
                    .foregroundStyle(.secondary)
            }
        case .loaded:
            if let participant = communityStore.lookupResult {
                HStack(spacing: 12) {
                    AvatarView(participant: participant, size: 44)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(participant.displayName)
                        Text("@\(participant.username)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if communityStore.containsMember(participant.id, in: conversation.id) {
                        Text(conversation.kind == .channel ? "Уже подписчик" : "Уже участник")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    } else {
                        Button("Добавить") {
                            Task {
                                if await communityStore.addMember(
                                    participant,
                                    role: selectedRole,
                                    to: conversation.id
                                ) {
                                    dismiss()
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!communityStore.canAddMember(role: selectedRole, to: conversation.id))
                        .accessibilityIdentifier("community-add-submit")
                    }
                }
            } else {
                Label("Пользователь не найден", systemImage: "person.crop.circle.badge.questionmark")
                    .foregroundStyle(.secondary)
            }
        case let .failed(detail):
            VStack(alignment: .leading, spacing: 8) {
                Label("Поиск не выполнен", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.red)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Повторить") {
                    Task { await communityStore.lookupMemberCandidate(normalizedUsername) }
                }
            }
        }
    }

    private var addFailure: CommunityMemberMutationFailure? {
        guard let participant = communityStore.lookupResult else { return nil }
        let key = CommunityMemberMutationKey(
            chatID: conversation.id,
            userID: participant.id,
            kind: .add
        )
        return communityStore.mutationFailures[key]
    }
}

private struct PhoneCommunityMutationFailureView: View {
    let failure: CommunityMemberMutationFailure
    let state: RemoteContentState
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(failure.key.kind.russianTitle) не выполнено")
                    .font(.subheadline.weight(.semibold))
                Text(failure.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if state == .loading {
                ProgressView()
                    .frame(width: 44, height: 44)
            } else {
                Button("Повторить", action: retry)
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Закрыть")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("community-mutation-failure")
    }
}

struct PhoneChannelReadOnlyComposer: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "megaphone.fill")
                .foregroundStyle(LuxoraTheme.iris)
            Text("Публиковать в этом канале могут только владелец и администраторы.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Канал только для чтения. Публиковать могут владелец и администраторы.")
        .accessibilityIdentifier("channel-read-only-composer")
    }
}
#endif

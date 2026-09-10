#if os(iOS)
import SwiftUI
import UIKit

#if DEBUG
@MainActor
private enum LuxoraPhoneDebugRouteGate {
    private static var didConsumeRoute = false

    static func consume() -> Bool {
        guard !didConsumeRoute else { return false }
        didConsumeRoute = true
        return true
    }
}
#endif

@inline(__always)
private func phoneString(_ key: String) -> String {
    LuxoraL10n.text(key)
}

public enum LuxoraPhoneInitialDestination: Equatable, Sendable {
    case inbox
    case contacts
    case spaces
    case calls
    case search
    case you
    case conversation(UUID)

    // Source-compatible aliases for the first checkpoint API.
    case chats
    case settings
}

public struct LuxoraPhoneRootView: View {
    @Bindable private var store: MessengerStore
    private let featureMatrix: LuxoraFeatureMatrix
    private let deviceSessionsStore: DeviceSessionsStore?
    private let phonePasswordSettingsStore: PhonePasswordSettingsStore?
    private let phoneBindingStore: PhoneBindingStore?
    private let notificationSettingsStore: NotificationSettingsStore?
    private let pushRegistrationStore: PushRegistrationStore?
    private let chatFoldersStore: ChatFoldersStore?
    private let communityStore: CommunityStore?
    private let globalSearchStore: GlobalSearchStore?
    private let updateChatPreferences: (UUID, ChatPreferencesPatch) async -> Bool
    private let synchronizePushAuthorization: (Bool) -> Void
    private let signOut: () -> Void

    @State private var selectedTab: PhoneTab
    @State private var contactsPath: [PhoneContactRoute]
    @State private var chatsPath: [PhoneChatRoute]
    @State private var settingsPath: [PhoneSettingsRoute]

    public init(
        store: MessengerStore,
        featureMatrix: LuxoraFeatureMatrix,
        initialDestination: LuxoraPhoneInitialDestination = .inbox,
        deviceSessionsStore: DeviceSessionsStore? = nil,
        phonePasswordSettingsStore: PhonePasswordSettingsStore? = nil,
        phoneBindingStore: PhoneBindingStore? = nil,
        notificationSettingsStore: NotificationSettingsStore? = nil,
        pushRegistrationStore: PushRegistrationStore? = nil,
        chatFoldersStore: ChatFoldersStore? = nil,
        communityStore: CommunityStore? = nil,
        globalSearchStore: GlobalSearchStore? = nil,
        updateChatPreferences: @escaping (UUID, ChatPreferencesPatch) async -> Bool = { _, _ in false },
        synchronizePushAuthorization: @escaping (Bool) -> Void = { _ in },
        signOut: @escaping () -> Void = {}
    ) {
        self.store = store
        self.featureMatrix = featureMatrix
        self.deviceSessionsStore = deviceSessionsStore
        self.phonePasswordSettingsStore = phonePasswordSettingsStore
        self.phoneBindingStore = phoneBindingStore
        self.notificationSettingsStore = notificationSettingsStore
        self.pushRegistrationStore = pushRegistrationStore
        self.chatFoldersStore = chatFoldersStore
        self.communityStore = communityStore
        self.globalSearchStore = globalSearchStore
        self.updateChatPreferences = updateChatPreferences
        self.synchronizePushAuthorization = synchronizePushAuthorization
        self.signOut = signOut
        _contactsPath = State(initialValue: [])
        _settingsPath = State(initialValue: [])

        switch initialDestination {
        case .inbox, .chats:
            _selectedTab = State(initialValue: .chats)
            _chatsPath = State(initialValue: [])
        case .contacts:
            _selectedTab = State(initialValue: .contacts)
            _chatsPath = State(initialValue: [])
        case .spaces:
            _selectedTab = State(initialValue: .chats)
            _chatsPath = State(initialValue: [.spaces])
        case .calls:
            _selectedTab = State(initialValue: .calls)
            _chatsPath = State(initialValue: [])
        case .search:
            _selectedTab = State(initialValue: .search)
            _chatsPath = State(initialValue: [])
        case .you, .settings:
            _selectedTab = State(initialValue: .settings)
            _chatsPath = State(initialValue: [])
        case let .conversation(conversationID):
            _selectedTab = State(initialValue: .chats)
            _chatsPath = State(initialValue: [.conversation(conversationID)])
        }
    }

    public var body: some View {
        TabView(selection: $selectedTab) {
            Tab(phoneString("tab.contacts"), systemImage: "person.crop.circle", value: .contacts) {
                NavigationStack(path: $contactsPath) {
                    PhoneContactsView(
                        store: store,
                        openProfile: { contactsPath.append(.profile($0)) }
                    )
                    .navigationDestination(for: PhoneContactRoute.self) { route in
                        switch route {
                        case let .profile(conversationID):
                            if let conversation = store.conversations.first(where: {
                                $0.id == conversationID
                            }) {
                                PhoneContactProfileView(
                                    conversation: conversation,
                                    messages: store.messagesByConversation[conversationID, default: []],
                                    callsGate: featureMatrix.calls,
                                    mediaGate: featureMatrix.mediaFiles,
                                    openMessage: { openConversation(conversationID) }
                                )
                                .toolbarVisibility(.hidden, for: .tabBar)
                            }
                        }
                    }
                }
            }
            .accessibilityIdentifier("tab-contacts")

            Tab(phoneString("tab.calls"), systemImage: "phone.fill", value: .calls) {
                NavigationStack {
                    PhoneCallsView(gate: featureMatrix.calls)
                }
            }
            .accessibilityIdentifier("tab-calls")

            Tab(phoneString("tab.chats"), systemImage: "bubble.left.and.bubble.right.fill", value: .chats) {
                NavigationStack(path: $chatsPath) {
                    PhoneInboxView(
                        store: store,
                        storiesGate: featureMatrix.stories,
                        securityGate: featureMatrix.securityE2EE,
                        openConversation: openConversation,
                        openRequests: { chatsPath.append(.requests) },
                        openSpaces: { chatsPath.append(.spaces) },
                        openEdit: { chatsPath.append(.edit) },
                        chatFoldersStore: chatFoldersStore,
                        updateChatPreferences: updateChatPreferences
                    )
                    .navigationDestination(for: PhoneChatRoute.self) { route in
                        switch route {
                        case let .conversation(conversationID):
                            if let conversation = store.conversations.first(where: {
                                $0.id == conversationID
                            }) {
                                PhoneDirectConversationView(
                                    store: store,
                                    conversation: conversation,
                                    callsGate: featureMatrix.calls,
                                    mediaGate: featureMatrix.mediaFiles,
                                    securityGate: featureMatrix.securityE2EE,
                                    communityStore: communityStore,
                                    openCommunityProfile: {
                                        chatsPath.append(.communityProfile(conversationID))
                                    }
                                )
                                .toolbarVisibility(.hidden, for: .tabBar)
                            } else {
                                ContentUnavailableView(
                                    "Переписка недоступна",
                                    systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                    description: Text("Сервер не вернул эту переписку.")
                                )
                            }
                        case .spaces:
                            if let communityStore {
                                PhoneCommunitiesView(
                                    communityStore: communityStore,
                                    communityListState: store.conversationListState,
                                    refreshCommunities: {
                                        await store.refreshConversations()
                                        try? communityStore.synchronizeConfirmedCommunities(store.conversations)
                                    },
                                    openConversation: openConversation,
                                    acceptCreatedCommunity: store.applyRealtimeConversation
                                )
                                .toolbarVisibility(.hidden, for: .tabBar)
                            } else {
                                PhoneSpacesView(gate: featureMatrix.communities)
                                    .toolbarVisibility(.hidden, for: .tabBar)
                            }
                        case let .communityProfile(conversationID):
                            if let communityStore,
                               let conversation = communityStore.community(conversationID)
                                    ?? store.conversations.first(where: { $0.id == conversationID }) {
                                PhoneCommunityProfileView(
                                    communityStore: communityStore,
                                    initialConversation: conversation,
                                    openConversation: { returnToConversation($0) },
                                    leftCommunity: { _ in
                                        chatsPath = [.spaces]
                                    }
                                )
                                .toolbarVisibility(.hidden, for: .tabBar)
                            } else {
                                ContentUnavailableView(
                                    "Сообщество недоступно",
                                    systemImage: "person.3.sequence.fill",
                                    description: Text("Сервер больше не возвращает эту группу или канал.")
                                )
                            }
                        case .requests:
                            PhoneMessageRequestsView(
                                store: store,
                                openConversation: openConversation
                            )
                            .toolbarVisibility(.hidden, for: .tabBar)
                        case .edit:
                            PhoneEditChatsView(
                                store: store,
                                storiesGate: featureMatrix.stories,
                                chatFoldersStore: chatFoldersStore
                            )
                                .toolbarVisibility(.hidden, for: .tabBar)
                        }
                    }
                }
            }
            .accessibilityIdentifier("tab-chats")

            Tab(phoneString("tab.settings"), systemImage: "gearshape.fill", value: .settings) {
                NavigationStack(path: $settingsPath) {
                    PhoneYouView(
                        store: store,
                        featureMatrix: featureMatrix,
                        phonePasswordSettingsStore: phonePasswordSettingsStore,
                        phoneBindingStore: phoneBindingStore,
                        chatFoldersStore: chatFoldersStore,
                        openRoute: { settingsPath.append($0) },
                        openSaved: openConversationFromYou,
                        openCalls: { selectedTab = .calls },
                        signOut: signOut
                    )
                    .navigationDestination(for: PhoneSettingsRoute.self) { route in
                        settingsDestination(route)
                            .toolbarVisibility(.hidden, for: .tabBar)
                    }
                }
            }
            .accessibilityIdentifier("tab-settings")

            Tab(
                phoneString("tab.search"),
                systemImage: "magnifyingglass",
                value: .search,
                role: .search
            ) {
                NavigationStack {
                    PhoneSearchView(
                        store: store,
                        searchStore: globalSearchStore,
                        searchGate: featureMatrix.search,
                        openConversation: openConversation,
                        close: { selectedTab = .chats }
                    )
                }
            }
            .accessibilityIdentifier("tab-search")
        }
        .tint(LuxoraTheme.accent)
        .preferredColorScheme(colorScheme)
        #if DEBUG
        .task { applyDebugRouteIfNeeded() }
        #endif
    }

    private var colorScheme: ColorScheme? {
        switch store.preferredAppearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    private func openConversation(_ conversationID: UUID) {
        store.selectConversation(conversationID)
        selectedTab = .chats
        let route = PhoneChatRoute.conversation(conversationID)
        guard chatsPath.last != route else { return }
        chatsPath.append(route)
    }

    private func openConversationFromYou(_ conversationID: UUID) {
        openConversation(conversationID)
    }

    private func returnToConversation(_ conversationID: UUID) {
        store.selectConversation(conversationID)
        selectedTab = .chats
        let target = PhoneChatRoute.conversation(conversationID)
        if let index = chatsPath.lastIndex(of: target) {
            chatsPath = Array(chatsPath.prefix(through: index))
        } else {
            chatsPath.append(target)
        }
    }

    @ViewBuilder
    private func settingsDestination(_ route: PhoneSettingsRoute) -> some View {
        switch route {
        case .folders:
            if let chatFoldersStore {
                PhoneChatFoldersSettingsView(
                    store: chatFoldersStore,
                    conversations: store.conversations
                )
            } else {
                ContentUnavailableView(
                    "Папки недоступны",
                    systemImage: "folder.badge.questionmark",
                    description: Text("Сервер не подтвердил контракт синхронизации папок.")
                )
            }
        case .profile:
            PhoneOwnProfileView(
                store: store,
                identityGate: featureMatrix.identityAccess,
                openIdentity: { settingsPath.append(.identity) },
                openCode: { settingsPath.append(.profileCode) }
            )
        case .profileCode:
            PhoneProfileCodeView(participant: store.currentUser)
        case .identity:
            PhoneGateSettingsView(
                title: phoneString("settings.identity"),
                gate: featureMatrix.identityAccess,
                planned: [
                    ("key.fill", "Ключи доступа", "Системная регистрация и вход на iPhone"),
                    ("lifepreserver.fill", "Восстановление", "Проверенное восстановление учётной записи"),
                ]
            )
        case .devices:
            PhoneServerDevicesSettingsView(
                store: deviceSessionsStore,
                gate: featureMatrix.devices,
                signOut: signOut
            )
        case .phonePassword:
            PhonePasswordSettingsView(
                store: phonePasswordSettingsStore,
                bindingStore: phoneBindingStore
            )
        case .notifications:
            PhoneNotificationsSettingsView(
                pushGate: featureMatrix.pushJobs,
                settingsStore: notificationSettingsStore,
                registrationStore: pushRegistrationStore,
                synchronizeAuthorization: synchronizePushAuthorization
            )
        case .privacy:
            PhonePrivacySettingsView(store: store, featureMatrix: featureMatrix)
        case .data:
            PhoneDataSettingsView(featureMatrix: featureMatrix)
        case .appearance:
            PhoneAppearanceSettingsView(store: store)
        case .power:
            PhonePowerSettingsView(store: store)
        case .language:
            PhoneLanguageSettingsView()
        case .plus:
            PhoneTargetSettingsView(
                title: "Luxora Plus",
                symbol: "star.fill",
                detail: "Платная подписка и коммерческие функции не входят в Beta-0.1 и не подключены к серверу."
            )
        case .help:
            PhoneHelpSettingsView()
        case .faq:
            PhoneTargetSettingsView(
                title: phoneString("settings.faq"),
                symbol: "questionmark.circle.fill",
                detail: "Русская база знаний будет опубликована вместе с проверенными материалами поддержки."
            )
        case .features:
            PhoneFeaturesSettingsView(featureMatrix: featureMatrix)
        case .about:
            PhoneAboutSettingsView(featureMatrix: featureMatrix)
        }
    }

    #if DEBUG
    private func applyDebugRouteIfNeeded() {
        guard LuxoraPhoneDebugRouteGate.consume() else { return }

        let environment = ProcessInfo.processInfo.environment
        if chatFoldersStore == nil,
           let rawFolder = environment["LUXORA_UI_TEST_INITIAL_FOLDER"],
           let folder = ConversationFolder(rawValue: rawFolder) {
                store.selectedFolder = folder
        }
        if let liveAutomation = DebugLaunchAutomation(environment: environment),
           let conversationID = liveAutomation.conversationID,
           store.conversations.contains(where: { $0.id == conversationID }) {
            openConversation(conversationID)
            return
        }

        switch environment["LUXORA_UI_TEST_DESTINATION"]?.lowercased() {
        case "contacts": selectedTab = .contacts
        case "spaces": openChatRoute(.spaces)
        case "calls": selectedTab = .calls
        case "search": selectedTab = .search
        case "chats", "inbox": selectedTab = .chats
        case "you", "settings": selectedTab = .settings
        case "edit-chats": openChatRoute(.edit)
        case "message-requests": openChatRoute(.requests)
        case "contact-profile":
            if let conversationID = store.conversations.first(where: { $0.kind == .direct })?.id {
                selectedTab = .contacts
                contactsPath = [.profile(conversationID)]
            }
        case "you-folders": openYouRoute(.folders)
        case "you-profile": openYouRoute(.profile)
        case "you-profile-qr": openYouRoute(.profileCode)
        case "you-identity": openYouRoute(.identity)
        case "you-devices": openYouRoute(.devices)
        case "you-phone-password": openYouRoute(.phonePassword)
        case "you-notifications": openYouRoute(.notifications)
        case "you-privacy": openYouRoute(.privacy)
        case "you-data": openYouRoute(.data)
        case "you-appearance": openYouRoute(.appearance)
        case "you-power": openYouRoute(.power)
        case "you-language": openYouRoute(.language)
        case "you-plus": openYouRoute(.plus)
        case "you-help": openYouRoute(.help)
        case "you-faq": openYouRoute(.faq)
        case "you-features": openYouRoute(.features)
        case "you-about": openYouRoute(.about)
        case "conversation":
            if let rawID = environment["LUXORA_UI_TEST_CONVERSATION_ID"],
               let conversationID = UUID(uuidString: rawID),
               store.conversations.contains(where: { $0.id == conversationID }) {
                openConversation(conversationID)
            } else if let conversationID = store.conversations.first?.id {
                openConversation(conversationID)
            }
        default: selectedTab = .chats
        }
    }

    private func openYouRoute(_ route: PhoneSettingsRoute) {
        selectedTab = .settings
        settingsPath = [route]
    }

    private func openChatRoute(_ route: PhoneChatRoute) {
        selectedTab = .chats
        chatsPath = [route]
    }
    #endif
}

private enum PhoneTab: Hashable {
    case contacts
    case calls
    case chats
    case settings
    case search
}

private enum PhoneChatRoute: Hashable {
    case conversation(UUID)
    case communityProfile(UUID)
    case spaces
    case requests
    case edit
}

private enum PhoneContactRoute: Hashable {
    case profile(UUID)
}

private enum PhoneSettingsRoute: Hashable {
    case folders
    case profile
    case profileCode
    case identity
    case devices
    case phonePassword
    case notifications
    case privacy
    case data
    case appearance
    case power
    case language
    case plus
    case help
    case faq
    case features
    case about
}

private struct PhoneContactsView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var store: MessengerStore
    let openProfile: (UUID) -> Void

    @State private var query = ""
    @AppStorage("luxora.contacts.onlineFirst") private var onlineFirst = true
    @State private var presentedGate: FeatureGate?

    private let russianAlphabet = PhoneContactSection.russianAlphabet

    private var contactGate: FeatureGate {
        FeatureGate(
            id: "contacts",
            title: phoneString("contacts.title"),
            symbol: "person.badge.plus",
            state: .unavailable,
            detail: "Сервер Luxora пока не поддерживает синхронизацию адресной книги, приглашения и добавление контактов."
        )
    }

    private var filteredContacts: [Conversation] {
        store.conversations
            .filter { $0.kind == .direct }
            .filter {
                query.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(query)
                    || $0.avatar.username.localizedCaseInsensitiveContains(query)
            }
    }

    private var contactSections: [PhoneContactSection] {
        let grouped = Dictionary(grouping: filteredContacts) { conversation in
            PhoneContactSection.normalizedLetter(for: conversation.title)
        }

        return russianAlphabet.compactMap { letter in
            guard let conversations = grouped[letter], !conversations.isEmpty else { return nil }
            return PhoneContactSection(
                letter: letter,
                conversations: conversations.sorted { lhs, rhs in
                    if onlineFirst, lhs.avatar.isOnline != rhs.avatar.isOnline {
                        return lhs.avatar.isOnline
                    }
                    return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
                }
            )
        }
    }

    var body: some View {
        let projectedContactSections = contactSections

        ScrollViewReader { proxy in
            ZStack(alignment: .trailing) {
                List {
                    Section {
                        Button {
                            presentedGate = contactGate
                        } label: {
                            Label(phoneString("contacts.invite"), systemImage: "person.badge.plus")
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityHint(phoneString("contacts.loaded_only"))
                        .accessibilityIdentifier("contacts-invite-gated")

                        ForEach(projectedContactSections) { section in
                            ForEach(section.conversations) { conversation in
                                Button { openProfile(conversation.id) } label: {
                                    HStack(spacing: 12) {
                                        AvatarView(participant: conversation.avatar, size: 40)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(conversation.title)
                                                .font(.body.weight(.semibold))
                                                .foregroundStyle(.primary)
                                            Text(conversation.avatar.isOnline ? phoneString("common.online").lowercased() : conversation.avatar.status)
                                                .font(.callout)
                                                .foregroundStyle(conversation.avatar.isOnline ? LuxoraTheme.iris : .secondary)
                                                .lineLimit(1)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                }
                                .buttonStyle(.plain)
                                .listRowInsets(.init(top: 1, leading: 16, bottom: 1, trailing: 30))
                                .id(
                                    conversation.id == section.conversations.first?.id
                                        ? section.anchorID
                                        : "contact-anchor-\(conversation.id.uuidString.lowercased())"
                                )
                                .accessibilityIdentifier("contact-row-\(conversation.id.uuidString.lowercased())")
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .listSectionSpacing(.compact)
                .environment(\.defaultMinListRowHeight, 54)
                .accessibilityIdentifier("contacts-screen")

                PhoneContactsAlphabetRail(
                    letters: russianAlphabet,
                    availableLetters: Set(projectedContactSections.map(\.letter))
                ) { letter in
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
                        proxy.scrollTo(PhoneContactSection.anchorID(for: letter), anchor: .top)
                    }
                }
                .padding(.top, 50)
                .padding(.trailing, 1)
            }
        }
        .overlay {
            if projectedContactSections.isEmpty {
                ContentUnavailableView(
                    phoneString("contacts.no_results"),
                    systemImage: "person.crop.circle.badge.questionmark"
                )
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: phoneString("contacts.search"))
        .navigationTitle(phoneString("contacts.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu(phoneString("contacts.sort_short")) {
                    Button(phoneString("contacts.online_first"), systemImage: onlineFirst ? "checkmark" : "circle") {
                        onlineFirst = true
                    }
                    Button(phoneString("contacts.by_name"), systemImage: onlineFirst ? "circle" : "checkmark") {
                        onlineFirst = false
                    }
                }
                .accessibilityIdentifier("contacts-sort")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(phoneString("contacts.add"), systemImage: "plus") {
                    presentedGate = contactGate
                }
                .accessibilityIdentifier("contacts-add-gated")
            }
        }
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
                .presentationDetents([.medium])
        }
    }
}

private struct PhoneContactSection: Identifiable {
    static let russianAlphabet = [
        "А", "Б", "В", "Г", "Д", "Е", "Ё", "Ж", "З", "И", "Й", "К", "Л", "М", "Н", "О", "П",
        "Р", "С", "Т", "У", "Ф", "Х", "Ц", "Ч", "Ш", "Щ", "Ъ", "Ы", "Ь", "Э", "Ю", "Я", "#",
    ]

    let letter: String
    let conversations: [Conversation]

    var id: String { letter }
    var anchorID: String { Self.anchorID(for: letter) }

    static func anchorID(for letter: String) -> String {
        "contact-section-\(letter)"
    }

    static func normalizedLetter(for name: String) -> String {
        let normalized = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased(with: Locale(identifier: "ru_RU"))
        guard let first = normalized.first else { return "#" }
        let letter = String(first)
        return russianAlphabet.contains(letter) ? letter : "#"
    }
}

private struct PhoneContactsAlphabetRail: View {
    let letters: [String]
    let availableLetters: Set<String>
    let select: (String) -> Void

    @State private var currentLetter: String?

    private var navigableLetters: [String] {
        letters.filter(availableLetters.contains)
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(letters, id: \.self) { letter in
                PhoneContactsAlphabetLetterButton(
                    letter: letter,
                    isAvailable: availableLetters.contains(letter)
                ) {
                    currentLetter = letter
                    select(letter)
                }
            }
        }
        .padding(.vertical, 3)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.16), lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(phoneString("contacts.alphabet_label"))
        .accessibilityHint(phoneString("contacts.alphabet_hint"))
        .accessibilityScrollAction { edge in
            switch edge {
            case .top, .leading: move(by: -1)
            case .bottom, .trailing: move(by: 1)
            }
        }
        .accessibilityAction(named: Text(phoneString("contacts.alphabet_previous"))) { move(by: -1) }
        .accessibilityAction(named: Text(phoneString("contacts.alphabet_next"))) { move(by: 1) }
        .accessibilityIdentifier("contacts-alphabet-rail")
        .task {
            if currentLetter == nil {
                currentLetter = navigableLetters.first
            }
        }
        .onChange(of: availableLetters) { _, _ in
            if let currentLetter, availableLetters.contains(currentLetter) { return }
            currentLetter = navigableLetters.first
        }
    }

    private func move(by offset: Int) {
        guard !navigableLetters.isEmpty else { return }
        let index = currentLetter.flatMap { navigableLetters.firstIndex(of: $0) } ?? 0
        let targetIndex = min(max(index + offset, navigableLetters.startIndex), navigableLetters.index(before: navigableLetters.endIndex))
        let target = navigableLetters[targetIndex]
        currentLetter = target
        select(target)
    }
}

private struct PhoneContactsAlphabetLetterButton: View {
    let letter: String
    let isAvailable: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(letter)
                .font(.system(size: 8.5, weight: isAvailable ? .semibold : .regular))
                .frame(width: 22, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isAvailable ? LuxoraTheme.iris : Color.secondary.opacity(0.35))
        .disabled(!isAvailable)
        .accessibilityLabel(String(format: phoneString("contacts.alphabet_letter"), letter))
        .accessibilityValue(
            isAvailable
                ? phoneString("contacts.alphabet_available")
                : phoneString("contacts.alphabet_unavailable")
        )
        .accessibilityIdentifier("contact-index-\(letter)")
    }
}

private struct PhoneContactProfileView: View {
    let conversation: Conversation
    let messages: [ChatMessage]
    let callsGate: FeatureGate
    let mediaGate: FeatureGate
    let openMessage: () -> Void

    @State private var presentedGate: FeatureGate?
    @State private var searchedConversation: Conversation?
    @State private var selectedSection = phoneString("profile.scope.media")
    @State private var showsMoreActions = false
    @State private var showsCopiedConfirmation = false

    private var profileGate: FeatureGate {
        FeatureGate(
            id: "contact-profile-actions",
            title: "Действия с контактом",
            symbol: "person.crop.circle.badge.exclamationmark",
            state: .unavailable,
            detail: "Сервер пока не поддерживает изменение контакта, отключение уведомлений и дополнительные действия."
        )
    }

    private var loadedSearchGate: FeatureGate {
        FeatureGate(
            id: "loaded-message-search",
            title: "Поиск в переписке",
            symbol: "magnifyingglass",
            state: .unavailable,
            detail: "На этом iPhone ещё нет загруженных сообщений этой переписки. Luxora не показывает выдуманные результаты."
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 8) {
                    AvatarView(participant: conversation.avatar, size: 100)
                    Text(conversation.title)
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .minimumScaleFactor(0.74)
                        .lineLimit(1)
                    Text(conversation.avatar.isOnline ? "в сети" : conversation.avatar.status)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .offset(y: -17)
                }
                // The binding profile reference lets the 100 pt portrait overlap
                // the navigation-bar vertical band instead of starting below it.
                .padding(.top, -37)

                HStack(spacing: 8) {
                    PhoneProfileAction(
                        symbol: "phone.fill",
                        title: phoneString("profile.action.call"),
                        isAvailable: false,
                        identifier: "contact-profile-action-call"
                    ) { presentedGate = callsGate }
                    PhoneProfileAction(
                        symbol: "video.fill",
                        title: phoneString("profile.action.video"),
                        isAvailable: false,
                        identifier: "contact-profile-action-video"
                    ) { presentedGate = callsGate }
                    PhoneProfileAction(
                        symbol: "bell.slash.fill",
                        title: phoneString("profile.action.mute"),
                        isAvailable: false,
                        identifier: "contact-profile-action-mute"
                    ) { presentedGate = profileGate }
                    PhoneProfileAction(
                        symbol: "magnifyingglass",
                        title: phoneString("profile.action.search"),
                        isAvailable: !messages.isEmpty,
                        identifier: "contact-profile-action-search"
                    ) {
                        if messages.isEmpty {
                            presentedGate = loadedSearchGate
                        } else {
                            searchedConversation = conversation
                        }
                    }
                    PhoneProfileAction(
                        symbol: "ellipsis",
                        title: phoneString("profile.action.more"),
                        isAvailable: true,
                        identifier: "contact-profile-action-more"
                    ) { showsMoreActions = true }
                }

                VStack(alignment: .leading, spacing: 0) {
                    ProfileDetailLine(
                        title: phoneString("profile.mobile"),
                        value: phoneString("profile.mobile_hidden")
                    )
                    Divider().padding(.leading, 16)
                    ProfileDetailLine(
                        title: phoneString("profile.username"),
                        value: "@\(conversation.avatar.username)"
                    )
                    Divider().padding(.leading, 16)
                    ProfileDetailLine(
                        title: phoneString("profile.birthday"),
                        value: phoneString("profile.birthday_unknown")
                    )
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .padding(.top, 13)
                .accessibilityIdentifier("contact-profile-details")

                VStack(spacing: 16) {
                    PhoneProfileContentScopeRail(selection: $selectedSection)
                    PhoneProfileLockedMediaGrid(section: selectedSection) {
                        presentedGate = mediaGate
                    }
                }
                .padding(.top, -5)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(phoneString("profile.edit")) {
                    presentedGate = profileGate
                }
                .accessibilityIdentifier("contact-profile-edit-gated")
            }
        }
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
                .presentationDetents([.medium])
        }
        .sheet(item: $searchedConversation) { conversation in
            PhoneLoadedMessageSearchView(conversation: conversation, messages: messages)
        }
        .confirmationDialog(
            phoneString("profile.actions_title"),
            isPresented: $showsMoreActions,
            titleVisibility: .visible
        ) {
            Button(phoneString("profile.write_message"), action: openMessage)
            Button("Скопировать username") {
                UIPasteboard.general.string = "@\(conversation.avatar.username)"
                showsCopiedConfirmation = true
            }
            Button(phoneString("profile.edit_contact")) { presentedGate = profileGate }
            Button(phoneString("common.cancel"), role: .cancel) {}
        }
        .alert("Username скопирован", isPresented: $showsCopiedConfirmation) {
            Button("ОК", role: .cancel) {}
        } message: {
            Text("@\(conversation.avatar.username) сохранён в буфере обмена этого iPhone.")
        }
        .accessibilityIdentifier("contact-profile-screen")
    }
}

private struct PhoneProfileAction: View {
    let symbol: String
    let title: String
    let isAvailable: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: symbol)
                        .font(.title3.weight(.semibold))
                        .frame(height: 26)
                    if !isAvailable {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 8, weight: .bold))
                            .padding(3)
                            .background(.thinMaterial, in: Circle())
                            .offset(x: 7, y: -5)
                    }
                }
                Text(title)
                    .font(.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(isAvailable ? LuxoraTheme.iris : .secondary)
            .frame(maxWidth: .infinity)
            .frame(height: 58)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            isAvailable
                ? title
                : String(format: phoneString("profile.action_unavailable"), title)
        )
        .accessibilityIdentifier(identifier)
    }
}

private struct PhoneProfileContentScopeRail: View {
    @Binding var selection: String

    private let scopes = [
        phoneString("profile.scope.media"),
        phoneString("profile.scope.files"),
        phoneString("profile.scope.voice"),
        phoneString("profile.scope.links"),
        phoneString("profile.scope.groups"),
    ]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(scopes, id: \.self) { scope in
                    Button {
                        selection = scope
                    } label: {
                        Text(scope)
                            .font(.subheadline.weight(selection == scope ? .semibold : .regular))
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .frame(height: 32)
                            .background {
                                if selection == scope {
                                    Capsule().fill(Color.primary.opacity(0.12))
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selection == scope ? Color.primary : Color.secondary)
                    .accessibilityAddTraits(selection == scope ? .isSelected : [])
                    .accessibilityIdentifier("contact-profile-scope-\(scope)")
                }
            }
            .padding(3)
        }
        .scrollIndicators(.hidden)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.12), lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(phoneString("profile.scope_label"))
        .accessibilityHint(phoneString("profile.scope_hint"))
        .accessibilityIdentifier("contact-profile-content-scopes")
    }
}

private struct PhoneProfileLockedMediaGrid: View {
    let section: String
    let openGate: () -> Void

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 3),
        count: 3
    )

    private var symbol: String {
        switch section {
        case phoneString("profile.scope.files"): "doc.fill"
        case phoneString("profile.scope.voice"): "waveform"
        case phoneString("profile.scope.links"): "link"
        case phoneString("profile.scope.groups"): "person.2.fill"
        default: "photo.fill.on.rectangle.fill"
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(0..<6, id: \.self) { index in
                    Button(action: openGate) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.secondary.opacity(index.isMultiple(of: 2) ? 0.10 : 0.07))
                            Image(systemName: symbol)
                                .font(.title3)
                                .foregroundStyle(.secondary.opacity(0.42))
                            Image(systemName: "lock.fill")
                                .font(.system(size: 9, weight: .bold))
                                .padding(4)
                                .background(.thinMaterial, in: Circle())
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                                .padding(7)
                        }
                        .aspectRatio(1, contentMode: .fit)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        String(format: phoneString("profile.content_locked_item"), section, index + 1)
                    )
                }
            }

            Label(phoneString("profile.content_unavailable"), systemImage: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .accessibilityIdentifier("contact-profile-content-grid")
    }
}

private struct ProfileDetailLine: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption)
            Text(value)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
}

private struct PhoneEditChatsView: View {
    @Bindable var store: MessengerStore
    let storiesGate: FeatureGate
    let chatFoldersStore: ChatFoldersStore?

    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<UUID> = []
    @State private var query = ""
    @State private var presentedGate: FeatureGate?

    private var folderEditingGate: FeatureGate {
        FeatureGate(
            id: "folder-editing",
            title: phoneString("folders.editing_title"),
            symbol: "folder.badge.questionmark",
            state: .unavailable,
            detail: phoneString("folders.editing_unavailable")
        )
    }

    private var visibleConversations: [Conversation] {
        let usesSynchronizedFolder = chatFoldersStore != nil
        let base = chatFoldersStore?.visibleConversations(from: store.conversations)
            ?? store.conversations.filter(store.selectedFolder.includes)
        let filtered = base.filter { conversation in
                query.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(query)
                    || conversation.subtitle.localizedCaseInsensitiveContains(query)
            }
        guard !usesSynchronizedFolder else { return filtered }
        return filtered.sorted { lhs, rhs in
            if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
            return lhs.lastActivity > rhs.lastActivity
        }
    }

    var body: some View {
        let projectedConversations = visibleConversations

        List {
            if showsStatusRail {
                Section {
                    PhoneStatusRail(
                        currentUser: store.currentUser,
                        conversations: store.conversations,
                        gate: storiesGate
                    )
                    .listRowSeparator(.hidden)
                    .listRowInsets(.init(top: 3, leading: 0, bottom: 4, trailing: 0))
                }
            }

            Section {
                PhoneInlineSearchField(text: $query)
                    .listRowSeparator(.hidden)
                    .listRowInsets(.init(top: 3, leading: 16, bottom: 4, trailing: 16))
            }

            Section {
                Group {
                    if let chatFoldersStore {
                        PhoneChatFolderRail(
                            store: chatFoldersStore,
                            conversations: store.conversations
                        )
                    } else {
                        InboxFolderStrip(
                            selection: $store.selectedFolder,
                            conversations: store.conversations,
                            requestRemoval: { _ in presentedGate = folderEditingGate }
                        )
                    }
                }
                .listRowSeparator(.hidden)
                .listRowInsets(.init(top: 1, leading: 0, bottom: 4, trailing: 0))
            }

            Section {
                ForEach(projectedConversations) { conversation in
                    Button {
                        if selected.contains(conversation.id) {
                            selected.remove(conversation.id)
                        } else {
                            selected.insert(conversation.id)
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: selected.contains(conversation.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title2)
                                .foregroundStyle(selected.contains(conversation.id) ? LuxoraTheme.iris : .secondary)
                            AvatarView(participant: conversation.avatar, size: 60)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(conversation.title)
                                    .font(.headline)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(conversation.subtitle)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: "line.3.horizontal")
                                    .font(.body.weight(.medium))
                                Image(systemName: "lock.fill")
                                    .font(.system(size: 7, weight: .bold))
                                    .offset(x: 5, y: -5)
                            }
                            .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(.init(top: 1, leading: 16, bottom: 1, trailing: 16))
                    .accessibilityLabel(
                        "\(conversation.title), \(selected.contains(conversation.id) ? phoneString("chats.selected") : phoneString("chats.not_selected")), \(phoneString("chats.reorder_unavailable"))"
                    )
                    .accessibilityIdentifier("edit-chat-row-\(conversation.id.uuidString.lowercased())")
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(.compact)
        .overlay {
            if projectedConversations.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle(phoneString("chats.title"))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(phoneString("common.done")) { dismiss() }
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                LockedEditAction(title: phoneString("chats.read_all"), symbol: "lock.fill")
                Spacer()
                LockedEditAction(title: phoneString("chats.archive"), symbol: "lock.fill")
                Spacer()
                LockedEditAction(title: phoneString("chats.delete"), symbol: "lock.fill")
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 11)
            .background(.ultraThinMaterial)
        }
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
                .presentationDetents([.medium])
        }
        .accessibilityIdentifier("edit-chats-screen")
    }

    private var showsStatusRail: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["LUXORA_UI_TEST_SHOW_STATUS_RAIL"] == "1"
        #else
        false
        #endif
    }
}

private struct PhoneInlineSearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(phoneString("chats.search"), text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .accessibilityLabel(phoneString("search.clear"))
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(Color.secondary.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.12), lineWidth: 0.5))
        .accessibilityIdentifier("edit-chats-search")
    }
}

private struct LockedEditAction: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(title), недоступно")
    }
}

private struct PhoneInboxView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var store: MessengerStore
    let storiesGate: FeatureGate
    let securityGate: FeatureGate
    let openConversation: (UUID) -> Void
    let openRequests: () -> Void
    let openSpaces: () -> Void
    let openEdit: () -> Void
    let chatFoldersStore: ChatFoldersStore?
    let updateChatPreferences: (UUID, ChatPreferencesPatch) async -> Bool

    @State private var query = ""
    @State private var isComposing = false
    @State private var presentedGate: FeatureGate?
    @State private var preferenceOperations: Set<UUID> = []
    @AppStorage("luxora.chatFolders.showNames") private var showsFolderNames = true

    private var visibleConversations: [Conversation] {
        let usesSynchronizedFolder = chatFoldersStore != nil
        let base = chatFoldersStore?.visibleConversations(from: store.conversations)
            ?? store.conversations.filter(store.selectedFolder.includes)
        let filtered = base.filter { conversation in
                query.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(query)
                    || conversation.subtitle.localizedCaseInsensitiveContains(query)
            }
        guard !usesSynchronizedFolder else { return filtered }
        return filtered.sorted(by: conversationOrder)
    }

    var body: some View {
        let projectedConversations = visibleConversations
        let presentsStatusRail = showsStatusRail
        let presentsExpandedTitle = usesExpandedTitle

        List {
            if presentsExpandedTitle {
                Section {
                    PhoneChatsTitleStack(conversations: [])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                        .listRowSeparator(.hidden)
                }
                .listRowBackground(Color.clear)
            }

            if store.connectionState != .online {
                Section {
                    ConnectionPill(connectionState: store.connectionState)
                        .listRowSeparator(.hidden)
                        .listRowInsets(.init(top: 5, leading: 16, bottom: 5, trailing: 16))
                }
            }

            if store.conversationListState == .loading {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Обновляем чаты…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("inbox-refreshing")
                }
            } else if case let .failed(message) = store.conversationListState,
                      !store.conversations.isEmpty {
                Section {
                    PhoneRemoteFailureRow(
                        title: "Не удалось обновить чаты",
                        detail: message,
                        retry: { Task { await store.refreshConversations() } }
                    )
                }
            }

            if presentsStatusRail {
                Section {
                    PhoneStatusRail(
                        currentUser: store.currentUser,
                        conversations: store.conversations,
                        gate: storiesGate
                    )
                    .listRowSeparator(.hidden)
                    .listRowInsets(.init(top: 3, leading: 0, bottom: 5, trailing: 0))
                }
            }

            Section {
                Button(action: openRequests) {
                    PhoneInboxMessageRequestsRow(
                        count: store.pendingIncomingMessageRequestCount
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("inbox-message-requests")
            }

            Section {
                Group {
                    if let chatFoldersStore {
                        PhoneChatFolderRail(
                            store: chatFoldersStore,
                            conversations: store.conversations
                        )
                    } else {
                        InboxFolderStrip(
                            selection: $store.selectedFolder,
                            conversations: store.conversations
                        )
                    }
                }
                .listRowSeparator(.hidden)
                .listRowInsets(.init(top: 2, leading: 0, bottom: 5, trailing: 0))
            }

            Section {
                ForEach(projectedConversations) { conversation in
                    Button {
                        openConversation(conversation.id)
                    } label: {
                        PhoneConversationRow(
                            conversation: conversation,
                            folderNames: showsFolderNames
                                ? chatFoldersStore?.folders
                                    .filter { $0.includes(conversation) }
                                    .map(\.title) ?? []
                                : []
                        )
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(uiColor: .label))
                    .listRowBackground(Color(uiColor: .systemBackground))
                    .listRowInsets(.init(top: 1, leading: 16, bottom: 1, trailing: 12))
                    .accessibilityIdentifier("inbox-row-\(conversation.id.uuidString.lowercased())")
                    .id(conversation.id)
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            toggleMute(conversation)
                        } label: {
                            Label(
                                conversation.isMuted ? "Включить звук" : "Без звука",
                                systemImage: conversation.isMuted ? "speaker.wave.2.fill" : "speaker.slash.fill"
                            )
                        }
                        .tint(.orange)
                        .disabled(preferenceOperations.contains(conversation.id))
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button {
                            toggleArchive(conversation)
                        } label: {
                            Label(
                                conversation.isArchived ? "Вернуть" : "В архив",
                                systemImage: conversation.isArchived ? "tray.and.arrow.up.fill" : "archivebox.fill"
                            )
                        }
                        .tint(LuxoraTheme.iris)
                        .disabled(preferenceOperations.contains(conversation.id))
                    }
                    .contextMenu {
                        Button {
                            toggleMute(conversation)
                        } label: {
                            Label(
                                conversation.isMuted ? "Включить уведомления" : "Выключить уведомления",
                                systemImage: conversation.isMuted ? "speaker.wave.2" : "speaker.slash"
                            )
                        }
                        Button {
                            toggleArchive(conversation)
                        } label: {
                            Label(
                                conversation.isArchived ? "Вернуть из архива" : "Архивировать",
                                systemImage: conversation.isArchived ? "tray.and.arrow.up" : "archivebox"
                            )
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        // The iOS 26 floating tab bar otherwise composites over the last
        // partially visible row. Shrink the List's real layout viewport so
        // text and unread badges never sit beneath translucent tab chrome.
        .padding(.bottom, dynamicTypeSize.isAccessibilitySize ? 96 : 64)
        // Rebuild the lazy layout shell when the system changes text size so
        // cached row heights never leave scaled text behind.
        .id(dynamicTypeSize)
        .accessibilityRotor("Чаты") {
            ForEach(projectedConversations) { conversation in
                AccessibilityRotorEntry(conversation.title, id: conversation.id)
            }
        }
        .refreshable {
            await store.refreshConversations()
        }
        .overlay {
            if projectedConversations.isEmpty {
                inboxEmptyState
            }
        }
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: phoneString("chats.search")
        )
        .navigationTitle(presentsExpandedTitle ? "" : phoneString("chats.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(phoneString("chats.edit_short"), action: openEdit)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel(phoneString("chats.edit"))
                    .accessibilityIdentifier("chats-edit")
            }
            ToolbarItem(placement: .principal) {
                if !presentsExpandedTitle {
                    PhoneChatsTitleStack(
                        conversations: presentsStatusRail ? [] : Array(store.conversations.prefix(3))
                    )
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(phoneString("feature.security.title"), systemImage: "shield") {
                    presentedGate = securityGate
                }
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("chats-security-gated")
                Button(phoneString("chats.spaces"), systemImage: "person.3.fill", action: openSpaces)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("chats-spaces")
                Button(phoneString("chats.new"), systemImage: "square.and.pencil") {
                    isComposing = true
                }
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("inbox-new-message")
            }
        }
        .sheet(isPresented: $isComposing) {
            PhoneNewMessageSheet(store: store, openConversation: openConversation)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
                .presentationDetents([.medium])
        }
        .onChange(of: store.conversations.lazy.filter(\.isArchived).count) { _, archivedCount in
            if archivedCount == 0, chatFoldersStore?.isArchiveSelected == true {
                chatFoldersStore?.select(nil)
            }
        }
        #if DEBUG
        .task {
            if ProcessInfo.processInfo.environment["LUXORA_UI_TEST_PRESENT_NEW_MESSAGE"] == "1" {
                isComposing = true
            }
        }
        #endif
        .accessibilityIdentifier("chats-screen")
    }

    @ViewBuilder
    private var inboxEmptyState: some View {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .loading = store.conversationListState, store.conversations.isEmpty {
            ProgressView("Загружаем чаты…")
                .accessibilityIdentifier("inbox-loading")
        } else if case let .failed(message) = store.conversationListState,
                  store.conversations.isEmpty {
            ContentUnavailableView {
                Label("Не удалось загрузить чаты", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Повторить") {
                    Task { await store.refreshConversations() }
                }
                .buttonStyle(.borderedProminent)
            }
            .accessibilityIdentifier("inbox-load-failed")
        } else if !normalizedQuery.isEmpty {
            ContentUnavailableView.search(text: normalizedQuery)
                .accessibilityIdentifier("inbox-empty-search")
        } else if store.conversations.isEmpty {
            ContentUnavailableView(
                "Чатов пока нет",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Новые переписки появятся здесь после синхронизации.")
            )
            .accessibilityIdentifier("inbox-empty-root")
        } else {
            ContentUnavailableView(
                "В этой папке пока нет чатов",
                systemImage: "folder",
                description: Text("Выберите другую папку или вернитесь ко всем чатам.")
            )
            .accessibilityIdentifier("inbox-empty-folder")
        }
    }

    private var showsStatusRail: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["LUXORA_UI_TEST_SHOW_STATUS_RAIL"] == "1"
        #else
        false
        #endif
    }

    private var usesExpandedTitle: Bool {
        dynamicTypeSize >= .xxLarge
    }

    private func conversationOrder(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
        return lhs.lastActivity > rhs.lastActivity
    }

    private func toggleArchive(_ conversation: Conversation) {
        performPreferenceUpdate(
            chatID: conversation.id,
            patch: ChatPreferencesPatch(archived: !conversation.isArchived)
        )
    }

    private func toggleMute(_ conversation: Conversation) {
        let mutedUntil: ChatMutedUntilPatch = conversation.isMuted
            ? .unmuted
            : .until(Date().addingTimeInterval(10 * 365 * 24 * 60 * 60))
        performPreferenceUpdate(
            chatID: conversation.id,
            patch: ChatPreferencesPatch(mutedUntil: mutedUntil)
        )
    }

    private func performPreferenceUpdate(chatID: UUID, patch: ChatPreferencesPatch) {
        guard preferenceOperations.insert(chatID).inserted else { return }
        Task {
            _ = await updateChatPreferences(chatID, patch)
            preferenceOperations.remove(chatID)
        }
    }
}

private struct PhoneInboxMessageRequestsRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let count: Int

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.title3.weight(.semibold))
                .foregroundStyle(LuxoraTheme.iris)
                .frame(width: 34, height: 34)
                .background(LuxoraTheme.iris.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(usesCompactCopy ? "Запросы" : "Запросы на переписку")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(usesCompactCopy
                    ? "От незнакомых"
                    : "Неизвестные отправители не видят прочтение до принятия")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 6)
            if count > 0 {
                Text("\(count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(LuxoraTheme.accent, in: Capsule())
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "Запросы на переписку. Неизвестные отправители не видят прочтение до принятия."
        )
        .accessibilityValue(count > 0 ? "Новых запросов: \(count)" : "Новых запросов нет")
        .accessibilityHint("Открывает входящие и исходящие запросы")
    }

    private var usesCompactCopy: Bool {
        dynamicTypeSize >= .xxLarge
    }
}

private struct PhoneMessageRequestsView: View {
    @Bindable var store: MessengerStore
    let openConversation: (UUID) -> Void

    @State private var direction: MessageRequestDirection = .incoming
    @State private var presentsNewRequest = false
    @State private var dismissalCandidate: MessageRequestItem?

    private var requests: [MessageRequestItem] { store.messageRequests(direction) }
    private var state: RemoteContentState { store.messageRequestListState(direction) }

    var body: some View {
        List {
            Section {
                Picker("Направление", selection: $direction) {
                    ForEach(MessageRequestDirection.allCases) { direction in
                        Text(direction.russianTitle).tag(direction)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("message-requests-direction")
            }
            .listRowBackground(Color.clear)

            Section {
                Label {
                    Text("До принятия отправитель не получает отметку о прочтении, точный статус присутствия или доступ к звонкам.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "hand.raised.fill")
                        .foregroundStyle(LuxoraTheme.iris)
                }
            }

            if case let .failed(message) = state {
                Section {
                    PhoneRemoteFailureRow(
                        title: "Не удалось обновить \(direction == .incoming ? "входящие" : "исходящие") запросы",
                        detail: message,
                        retry: {
                            Task { await store.loadMessageRequests(direction, force: true) }
                        }
                    )
                }
            }

            Section(direction.russianTitle) {
                if state == .loading, requests.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Загружаем запросы…")
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("message-requests-loading")
                } else if requests.isEmpty {
                    ContentUnavailableView(
                        direction == .incoming ? "Новых запросов нет" : "Исходящих запросов нет",
                        systemImage: direction == .incoming ? "person.crop.circle.badge.checkmark" : "paperplane",
                        description: Text(
                            direction == .incoming
                                ? "Незнакомые пользователи появятся здесь, не раскрывая им ваше прочтение."
                                : "Создайте запрос по точному username."
                        )
                    )
                    .accessibilityIdentifier("message-requests-empty-\(direction.rawValue)")
                } else {
                    ForEach(requests) { request in
                        PhoneMessageRequestRow(
                            request: request,
                            mutationState: store.messageRequestMutationState(request.id),
                            error: store.messageRequestMutationErrors[request.id],
                            accept: { store.acceptMessageRequest(request.id) },
                            dismiss: { dismissalCandidate = request },
                            retry: { store.retryMessageRequestMutation(request.id) }
                        )
                    }
                }
            }
        }
        .navigationTitle("Запросы на переписку")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Новый запрос", systemImage: "square.and.pencil") {
                    presentsNewRequest = true
                }
                .disabled(!store.supportsMessageRequestCreation)
                .accessibilityIdentifier("message-request-new")
            }
        }
        .refreshable {
            await store.loadMessageRequests(.incoming, force: true)
            await store.loadMessageRequests(.outgoing, force: true)
        }
        .sheet(isPresented: $presentsNewRequest) {
            PhoneNewMessageRequestSheet(store: store)
        }
        .confirmationDialog(
            "Удалить запрос?",
            isPresented: Binding(
                get: { dismissalCandidate != nil },
                set: { if !$0 { dismissalCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let dismissalCandidate {
                Button("Удалить", role: .destructive) {
                    store.dismissMessageRequest(dismissalCandidate.id)
                    self.dismissalCandidate = nil
                }
            }
            Button("Отмена", role: .cancel) { dismissalCandidate = nil }
        } message: {
            Text("Отправитель не узнает, что вы просмотрели или удалили запрос.")
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] == "1",
               !store.supportsMessageRequests {
                store.installDebugMessageRequestFixture()
            }
            #endif
            await store.loadMessageRequests(.incoming)
            await store.loadMessageRequests(.outgoing)
        }
        .onChange(of: store.lastAcceptedMessageRequestConversationID) { _, conversationID in
            guard let conversationID else { return }
            _ = store.consumeAcceptedMessageRequestConversation()
            openConversation(conversationID)
        }
        .accessibilityIdentifier("message-requests-screen")
    }
}

private struct PhoneMessageRequestRow: View {
    let request: MessageRequestItem
    let mutationState: RemoteContentState
    let error: String?
    let accept: () -> Void
    let dismiss: () -> Void
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                AvatarView(participant: request.participant, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text(request.participant.displayName)
                        .font(.body.weight(.semibold))
                    Text("@\(request.participant.username)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(request.body)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
                Spacer(minLength: 4)
                Text(request.createdAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.trailing)
            }

            if request.direction == .incoming, request.state == .pending {
                if mutationState == .loading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Подтверждаем на сервере…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("message-request-mutation-loading-\(request.id.uuidString.lowercased())")
                } else {
                    HStack(spacing: 10) {
                        Button("Принять", action: accept)
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("message-request-accept-\(request.id.uuidString.lowercased())")
                        Button("Удалить", role: .destructive, action: dismiss)
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("message-request-dismiss-\(request.id.uuidString.lowercased())")
                    }
                }
            } else {
                Label(request.state.russianTitle, systemImage: requestStateSymbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(request.state == .expired ? .secondary : LuxoraTheme.iris)
                    .accessibilityIdentifier("message-request-state-\(request.id.uuidString.lowercased())")
            }

            if let error {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Button("Повторить", action: retry)
                        .font(.caption.weight(.semibold))
                }
                .accessibilityIdentifier("message-request-mutation-error-\(request.id.uuidString.lowercased())")
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-request-row-\(request.id.uuidString.lowercased())")
    }

    private var requestStateSymbol: String {
        switch request.state {
        case .pending: "clock.fill"
        case .accepted: "checkmark.circle.fill"
        case .recipientDismissed: "trash.fill"
        case .expired: "hourglass.bottomhalf.filled"
        }
    }
}

private struct PhoneNewMessageRequestSheet: View {
    @Bindable var store: MessengerStore

    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var requestBody = ""
    @State private var didSubmit = false

    private var normalizedBody: String {
        requestBody.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Точный username") {
                    TextField("@username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit(search)
                        .accessibilityIdentifier("message-request-username")
                    Button("Найти", systemImage: "magnifyingglass", action: search)
                        .disabled(username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("message-request-lookup")
                }

                Section("Получатель") {
                    switch store.messageRequestLookupState {
                    case .idle:
                        Text("Введите точный username. Глобальный список пользователей не раскрывается.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    case .loading:
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Проверяем доступность…")
                        }
                    case .loaded:
                        if let participant = store.messageRequestLookupResult {
                            HStack(spacing: 12) {
                                AvatarView(participant: participant, size: 46)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(participant.displayName)
                                        .font(.body.weight(.semibold))
                                    Text("@\(participant.username)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityIdentifier("message-request-recipient")
                        } else {
                            Label("Пользователь недоступен", systemImage: "person.crop.circle.badge.xmark")
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("message-request-recipient-unavailable")
                        }
                    case let .failed(message):
                        PhoneRemoteFailureRow(title: "Поиск не выполнен", detail: message, retry: search)
                    }
                }

                if store.messageRequestLookupResult != nil {
                    Section("Первое сообщение") {
                        TextEditor(text: $requestBody)
                            .frame(minHeight: 110)
                            .accessibilityIdentifier("message-request-body")
                        Text("\(requestBody.unicodeScalars.count) из 1000 · вложения недоступны до принятия")
                            .font(.caption2)
                            .foregroundStyle(requestBody.unicodeScalars.count > 1_000 ? .red : .secondary)
                    }
                }

                if case let .failed(message) = store.messageRequestCreationState {
                    Section {
                        PhoneRemoteFailureRow(
                            title: "Запрос не отправлен",
                            detail: store.messageRequestCreationError ?? message,
                            retry: {
                                didSubmit = true
                                store.retryMessageRequestCreation()
                            }
                        )
                    }
                }

                Section {
                    Text("Получатель увидит только ваше публичное имя, username и это сообщение. До принятия Luxora не отправляет вам отметку о прочтении.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Новый запрос")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(store.messageRequestCreationState == .loading ? "Отправляем…" : "Отправить") {
                        guard let recipient = store.messageRequestLookupResult else { return }
                        didSubmit = true
                        store.createMessageRequest(to: recipient.id, body: normalizedBody)
                    }
                    .disabled(
                        store.messageRequestLookupResult == nil
                            || normalizedBody.isEmpty
                            || requestBody.unicodeScalars.count > 1_000
                            || store.messageRequestCreationState == .loading
                    )
                    .accessibilityIdentifier("message-request-send")
                }
            }
        }
        .onChange(of: requestBody) { _, value in
            if value.unicodeScalars.count > 1_000 {
                requestBody = String(value.unicodeScalars.prefix(1_000))
            }
        }
        .onChange(of: store.messageRequestCreationState) { _, state in
            if didSubmit, state == .loaded { dismiss() }
        }
        .accessibilityIdentifier("message-request-new-sheet")
    }

    private func search() {
        store.lookupMessageRequestRecipient(username)
    }
}

private struct PhoneChatsTitleStack: View {
    let conversations: [Conversation]

    private var titleConversations: [Conversation] {
        Array(conversations.prefix(3))
    }

    private var stackWidth: CGFloat {
        guard !titleConversations.isEmpty else { return 0 }
        return 24 + CGFloat(titleConversations.count - 1) * 13
    }

    var body: some View {
        HStack(spacing: 7) {
            if !titleConversations.isEmpty {
                ZStack(alignment: .leading) {
                    ForEach(Array(titleConversations.enumerated()), id: \.element.id) { index, conversation in
                        AvatarView(participant: conversation.avatar, size: 24, showsPresence: false)
                            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5))
                            .offset(x: CGFloat(index) * 13)
                    }
                }
                .frame(width: stackWidth, height: 26, alignment: .leading)
            }

            Text(phoneString("chats.title"))
                .font(.headline)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(phoneString("chats.title"))
        .accessibilityHeading(.h1)
        .accessibilityIdentifier("chats-title-stack")
    }
}

private struct InboxFolderStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var selection: ConversationFolder
    let conversations: [Conversation]
    let requestRemoval: ((ConversationFolder) -> Void)?

    @State private var scrollPosition: ConversationFolder?

    private let folders = ConversationFolder.allCases

    init(
        selection: Binding<ConversationFolder>,
        conversations: [Conversation],
        requestRemoval: ((ConversationFolder) -> Void)? = nil
    ) {
        _selection = selection
        self.conversations = conversations
        self.requestRemoval = requestRemoval
    }

    var body: some View {
        let projectedUnreadCount = unreadCount

        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(folders) { folder in
                    InboxFolderChip(
                        folder: folder,
                        isSelected: selection == folder,
                        unreadCount: projectedUnreadCount,
                        removalAction: requestRemoval.map { requestRemoval in
                            { requestRemoval(folder) }
                        }
                    ) {
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
                            selection = folder
                            scrollPosition = folder
                        }
                    }
                    .id(folder)
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
                scrollPosition = selection
            }
        }
        .onChange(of: selection) { _, newSelection in
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
                scrollPosition = newSelection
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(phoneString("folders.rail_label"))
        .accessibilityHint(phoneString("folders.rail_hint"))
        .accessibilityScrollAction { edge in
            switch edge {
            case .leading: move(by: -1)
            case .trailing: move(by: 1)
            default: break
            }
        }
        .accessibilityAction(named: Text(phoneString("folders.previous"))) { move(by: -1) }
        .accessibilityAction(named: Text(phoneString("folders.next"))) { move(by: 1) }
        .accessibilityIdentifier("chat-folder-rail")
    }

    private var unreadCount: Int {
        conversations.reduce(0) { $0 + $1.unreadCount }
    }

    private func move(by offset: Int) {
        let current = scrollPosition ?? selection
        guard let index = folders.firstIndex(of: current) else { return }
        let targetIndex = min(max(index + offset, folders.startIndex), folders.index(before: folders.endIndex))
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
            scrollPosition = folders[targetIndex]
        }
    }
}

private struct InboxFolderChip: View {
    let folder: ConversationFolder
    let isSelected: Bool
    let unreadCount: Int
    let removalAction: (() -> Void)?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 5) {
                    Text(folder.title)
                    if folder == .unread, unreadCount > 0 {
                        Text("\(unreadCount)")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.white.opacity(isSelected ? 0.22 : 0.08), in: Capsule())
                    }
                }
                .font(.subheadline.weight(isSelected ? .semibold : .regular))
                .padding(.leading, 14)
                .padding(.trailing, showsRemoval ? 5 : 14)
                .padding(.vertical, 7)
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityLabel(
                folder == .unread && unreadCount > 0
                    ? "\(folder.title), \(unreadCount)"
                    : folder.title
            )
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityValue(isSelected ? phoneString("folders.selected") : "")
            .accessibilityShowsLargeContentViewer {
                Text(folder.title)
            }
            .accessibilityIdentifier("inbox-folder-\(folder.rawValue)")

            if let removalAction, folder != .all {
                Button(action: removalAction) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(format: phoneString("folders.remove_unavailable"), folder.title))
                .accessibilityIdentifier("folder-remove-\(folder.rawValue)-gated")
            }
        }
        .foregroundStyle(isSelected ? .white : Color(uiColor: .label))
        .background {
            if isSelected {
                Capsule().fill(LuxoraTheme.brandGradient)
            }
        }
    }

    private var showsRemoval: Bool {
        removalAction != nil && folder != .all
    }
}

private struct PhoneStatusRail: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let currentUser: Participant
    let conversations: [Conversation]
    let gate: FeatureGate

    @State private var scrollPosition: String?
    @State private var presentedGate: FeatureGate?

    private var items: [StatusRailItem] {
        let mine = StatusRailItem(
            id: "mine-\(currentUser.id.uuidString.lowercased())",
            participant: currentUser,
            isMine: true
        )
        let contacts = conversations
            .filter { $0.kind == .direct }
            .map {
                StatusRailItem(
                    id: "conversation-\($0.id.uuidString.lowercased())",
                    participant: $0.avatar,
                    isMine: false
                )
            }
        return [mine] + contacts
    }

    var body: some View {
        let projectedItems = items

        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 4) {
                ForEach(projectedItems) { item in
                    Button {
                        scrollPosition = item.id
                        presentedGate = gate
                    } label: {
                        VStack(spacing: 5) {
                            ZStack(alignment: .bottomTrailing) {
                                Circle()
                                    .stroke(LuxoraTheme.brandGradient, lineWidth: 2.5)
                                    .frame(width: 62, height: 62)
                                AvatarView(participant: item.participant, size: 54, showsPresence: false)
                                    .padding(4)
                                Image(systemName: "lock.fill")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 18, height: 18)
                                    .background(Color.secondary, in: Circle())
                                    .overlay(Circle().stroke(.background, lineWidth: 2))
                            }

                            Text(item.isMine ? phoneString("stories.mine") : item.participant.displayName)
                                .font(usesExpandedLayout ? .body : .caption2)
                                .foregroundStyle(.primary)
                                .lineLimit(usesExpandedLayout ? nil : 1)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity)
                                .accessibilityHidden(true)
                        }
                        .frame(width: usesExpandedLayout ? 220 : 72)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "\(item.isMine ? phoneString("stories.mine") : item.participant.displayName), \(phoneString("stories.unavailable"))"
                    )
                    .accessibilityHint(gate.detail)
                    .accessibilityShowsLargeContentViewer {
                        Text(item.isMine ? phoneString("stories.mine") : item.participant.displayName)
                    }
                    .accessibilityIdentifier(
                        "status-item-\(item.participant.id.uuidString.lowercased())"
                    )
                    .id(item.id)
                }
            }
            .scrollTargetLayout()
            .id(dynamicTypeSize)
        }
        .frame(minHeight: usesExpandedLayout ? 168 : 92)
        .contentMargins(.horizontal, 12, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        .scrollPosition(id: $scrollPosition)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(phoneString("stories.rail_label"))
        .accessibilityHint(phoneString("stories.rail_hint"))
        .accessibilityScrollAction { edge in
            switch edge {
            case .leading: move(by: -1)
            case .trailing: move(by: 1)
            default: break
            }
        }
        .accessibilityAction(named: Text(phoneString("stories.previous"))) { move(by: -1) }
        .accessibilityAction(named: Text(phoneString("stories.next"))) { move(by: 1) }
        .accessibilityIdentifier("status-story-rail")
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
        }
        .task {
            if scrollPosition == nil {
                scrollPosition = projectedItems.first?.id
            }
        }
    }

    private var usesExpandedLayout: Bool {
        dynamicTypeSize >= .xxLarge
    }

    private func move(by offset: Int) {
        let projectedItems = items
        guard !projectedItems.isEmpty else { return }
        let current = scrollPosition ?? projectedItems[0].id
        let index = projectedItems.firstIndex(where: { $0.id == current }) ?? 0
        let targetIndex = min(
            max(index + offset, projectedItems.startIndex),
            projectedItems.index(before: projectedItems.endIndex)
        )
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
            scrollPosition = projectedItems[targetIndex].id
        }
    }
}

private struct StatusRailItem: Identifiable {
    let id: String
    let participant: Participant
    let isMine: Bool
}

private struct PhoneRemoteFailureRow: View {
    let title: String
    let detail: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button("Повторить", action: retry)
                .font(.callout.weight(.semibold))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-failure-row")
    }
}

private struct ConnectionPill: View {
    let connectionState: ConnectionState

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(title)
                .font(.caption.weight(.semibold))
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("connection-summary")
    }

    private var title: String {
        switch connectionState {
        case .online: "Подключено"
        case .connecting: "Подключение"
        case .offline: phoneString("connection.offline")
        case .degraded: phoneString("connection.interrupted")
        }
    }

    private var detail: String {
        switch connectionState {
        case .online: "Текстовые сообщения доступны"
        case .connecting: "Ожидаем обновления в реальном времени"
        case .offline: "Серверные действия приостановлены"
        case .degraded: "Повторите подключение в верхней панели"
        }
    }

    private var color: Color {
        switch connectionState {
        case .online: LuxoraTheme.success
        case .connecting: LuxoraTheme.electricBlue
        case .offline: .secondary
        case .degraded: .orange
        }
    }
}

private struct PhoneConversationRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: Conversation
    let folderNames: [String]

    init(conversation: Conversation, folderNames: [String] = []) {
        self.conversation = conversation
        self.folderNames = folderNames
    }

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(participant: conversation.avatar, size: 54)

            if usesExpandedLayout {
                VStack(alignment: .leading, spacing: 5) {
                    Text(conversation.title)
                        .font(.body.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(activityTime)
                        .font(.caption2)
                        .foregroundStyle(Color(uiColor: .label))
                        .fixedSize(horizontal: true, vertical: true)
                    folderTags
                    conversationSummary
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        Text(conversation.title)
                            .font(.body.weight(.semibold))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(activityTime)
                            .font(.caption2)
                            .foregroundStyle(Color(uiColor: .label))
                            .fixedSize(horizontal: true, vertical: true)
                    }
                    folderTags
                    conversationSummary
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(conversationAccessibilityLabel)
        .accessibilityHint("Открывает переписку")
    }

    @ViewBuilder
    private var folderTags: some View {
        if !folderNames.isEmpty {
            HStack(spacing: 4) {
                ForEach(Array(folderNames.prefix(2)), id: \.self) { name in
                    Text(name)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(LuxoraTheme.iris)
                        .background(LuxoraTheme.iris.opacity(0.11), in: Capsule())
                }
                if folderNames.count > 2 {
                    Text("+\(folderNames.count - 2)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Папки: \(folderNames.joined(separator: ", "))")
        }
    }

    private var conversationSummary: some View {
        HStack(spacing: 6) {
            Text(conversation.isTyping ? phoneString("chats.typing") : conversation.subtitle)
                .font(.callout)
                .foregroundStyle(conversation.isTyping ? typingColor : Color(uiColor: .label))
                .lineLimit(usesExpandedLayout ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if conversation.isMuted {
                Image(systemName: "speaker.slash.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            if conversation.unreadCount > 0 {
                Text("\(conversation.unreadCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(LuxoraTheme.accent, in: Capsule())
                    .accessibilityHidden(true)
            } else if conversation.isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
    }

    private var usesExpandedLayout: Bool {
        dynamicTypeSize >= .xxLarge
    }

    private var activityTime: String {
        conversation.lastActivity.formatted(date: .omitted, time: .shortened)
    }

    private var typingColor: Color {
        colorScheme == .dark ? LuxoraTheme.frost : LuxoraTheme.deepViolet
    }

    private var conversationAccessibilityLabel: String {
        var parts = [
            conversation.title,
            conversation.isTyping ? phoneString("chats.typing") : conversation.subtitle,
            "непрочитанных: \(conversation.unreadCount)",
        ]
        if conversation.isMuted { parts.append("уведомления выключены") }
        if conversation.isPinned { parts.append("закреплено") }
        if !folderNames.isEmpty { parts.append("папки: \(folderNames.joined(separator: ", "))") }
        return parts.joined(separator: ", ")
    }
}

private struct PhoneDirectConversationView: View {
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var store: MessengerStore
    let conversation: Conversation
    let callsGate: FeatureGate
    let mediaGate: FeatureGate
    let securityGate: FeatureGate
    let communityStore: CommunityStore?
    let openCommunityProfile: () -> Void

    @State private var presentedGate: FeatureGate?
    @State private var forwardedMessage: ChatMessage?
    @State private var deletionCandidate: ChatMessage?
    #if DEBUG
    @State private var didInstallDebugMessageMutations = false
    @State private var didApplyDebugMessageCaptureState = false
    #endif

    private var messages: [ChatMessage] {
        store.messagesByConversation[conversation.id, default: []]
    }

    private var messageState: RemoteContentState {
        store.messageState(for: conversation.id)
    }

    var body: some View {
        let displayedMessages = messages
        let currentMessageState = messageState
        let messagesPendingRetry = displayedMessages.filter {
            $0.isOutgoing && $0.delivery == .failed
        }

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    // At accessibility Dynamic Type sizes this context belongs
                    // to the scrollable transcript. Keeping it in the fixed
                    // top inset can consume almost the whole viewport and hide
                    // both the first message and the composer. The participant
                    // title remains fixed and fully readable below.
                    if usesExpandedMessageLayout {
                        if let pinnedMessage = store.pinnedMessages(for: conversation.id).last {
                            PhonePinnedContext(gate: securityGate, message: pinnedMessage)
                        } else if !store.supportsMessagePinning {
                            PhonePinnedContext(gate: securityGate)
                        }
                    }

                    if let failure = store.messageMutationFailure {
                        PhoneMessageMutationFailureNotice(
                            failure: failure,
                            retry: store.retryLastMessageMutation,
                            dismiss: store.dismissMessageMutationFailure
                        )
                    }

                    if !messagesPendingRetry.isEmpty {
                        PhoneSendFailureNotice(count: messagesPendingRetry.count) {
                            messagesPendingRetry.forEach { store.retryMessage($0.id) }
                        }
                    }

                    if case let .failed(message) = currentMessageState, !displayedMessages.isEmpty {
                        PhoneRemoteFailureRow(
                            title: "Не удалось обновить сообщения",
                            detail: message,
                            retry: {
                                Task { await store.loadMessages(for: conversation.id, force: true) }
                            }
                        )
                    }

                    Text(phoneString("conversation.today"))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color(uiColor: .label))
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background(
                            Color(uiColor: .secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                        .accessibilityAddTraits(.isHeader)

                    if displayedMessages.isEmpty, currentMessageState == .loading || currentMessageState == .idle {
                        ProgressView("Загружаем сообщения…")
                            .padding(.top, 48)
                            .accessibilityIdentifier("conversation-loading")
                    } else if displayedMessages.isEmpty, case let .failed(message) = currentMessageState {
                        ContentUnavailableView {
                            Label("Не удалось загрузить сообщения", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text(message)
                        } actions: {
                            Button("Повторить") {
                                Task { await store.loadMessages(for: conversation.id, force: true) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .padding(.top, 32)
                        .accessibilityIdentifier("conversation-load-failed")
                    } else if displayedMessages.isEmpty {
                        ContentUnavailableView(
                            phoneString("conversation.no_messages"),
                            systemImage: "text.bubble",
                            description: Text(phoneString("conversation.no_messages_detail"))
                        )
                        .padding(.top, 48)
                    } else {
                        ForEach(displayedMessages) { message in
                            let metadata = store.metadata(for: message.id)
                            PhoneMessageBubble(
                                message: message,
                                metadata: metadata,
                                showsAuthorName: conversation.kind == .group || conversation.kind == .channel,
                                isMutationInFlight: store.isMessageMutationInFlight(message.id),
                                retry: { store.retryMessage(message.id) },
                                react: { emoji in store.toggleReaction(emoji, messageID: message.id) },
                                reply: store.canReply(to: message) ? { store.beginReply(to: message) } : nil,
                                edit: store.canEdit(message) ? { store.beginEditing(message) } : nil,
                                delete: store.canDelete(message) ? { deletionCandidate = message } : nil,
                                forward: store.canForward(message) ? { forwardedMessage = message } : nil,
                                togglePin: store.canPin(message, in: conversation)
                                    ? { store.togglePin(message.id, in: conversation.id) }
                                    : nil
                            )
                                .padding(
                                    .bottom,
                                    usesExpandedMessageLayout && message.id == displayedMessages.last?.id
                                        ? 2
                                        : 0
                                )
                                .id(message.id)
                                .accessibilityIdentifier("message-\(message.id.uuidString.lowercased())")
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, usesExpandedMessageLayout ? 0 : 8)
            }
            .background {
                ZStack {
                    Color(uiColor: .systemGroupedBackground)
                    LuxoraTheme.ambientGradient.opacity(0.55)
                }
                .ignoresSafeArea()
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityRotor("Сообщения") {
                ForEach(displayedMessages) { message in
                    AccessibilityRotorEntry(
                        "\(message.author.displayName): \(message.text)",
                        id: message.id
                    )
                }
            }
            .refreshable {
                await store.loadMessages(for: conversation.id, force: true)
                await store.markConversationRead(conversation.id)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if usesExpandedMessageLayout {
                    conversationTitle(isExpanded: true)
                    // Navigation chrome must remain readable without taking
                    // the transcript's entire viewport at Accessibility XXXL.
                    // Message bodies keep the user's uncapped Dynamic Type.
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .background(Color(uiColor: .systemGroupedBackground))
                } else {
                    if let pinnedMessage = store.pinnedMessages(for: conversation.id).last {
                        PhonePinnedContext(gate: securityGate, message: pinnedMessage)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                    } else if !store.supportsMessagePinning {
                        PhonePinnedContext(gate: securityGate)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if conversation.kind == .channel,
                   communityStore?.canPublish(in: conversation) != true {
                    PhoneChannelReadOnlyComposer(conversation: conversation)
                } else {
                    MessageComposer(
                        store: store,
                        onAttachment: { presentedGate = mediaGate }
                    )
                }
            }
            .onChange(of: displayedMessages.count) { _, _ in
                guard let lastID = displayedMessages.last?.id else { return }
                withAnimation(reducesMotion ? nil : .snappy(duration: 0.24)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
            .task(id: "\(conversation.id.uuidString)-\(dynamicTypeSize)") {
                // Dynamic Type can change while this view is already alive.
                // Wait for the new bubble/composer measurements, then restore
                // the chat's bottom anchor so text is never left underneath
                // the composer using the previous geometry.
                await Task.yield()
                guard let lastID = displayedMessages.last?.id else { return }
                proxy.scrollTo(lastID, anchor: .bottom)
            }
        }
        .task(id: conversation.id) {
            #if DEBUG
            if !didInstallDebugMessageMutations,
               ProcessInfo.processInfo.environment["LUXORA_UI_TEST_MESSAGE_ACTIONS"] == "1" {
                if !store.supportsReplying {
                    store.installDebugMessageMutationFixture()
                }
                didInstallDebugMessageMutations = true
            }
            #endif
            await store.loadSynchronizedDraft(for: conversation.id)
            await store.loadMessages(for: conversation.id)
            await store.markConversationRead(conversation.id)
            #if DEBUG
            applyDebugMessageCaptureStateIfRequested()
            #endif
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.hidden, for: .tabBar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-screen")
        .toolbar {
            ToolbarItem(placement: .principal) {
                if !usesExpandedMessageLayout {
                    conversationTitle(isExpanded: false)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    presentedGate = callsGate
                } label: {
                    LockedToolbarIcon(symbol: "phone.fill")
                }
                .tint(.secondary)
                .accessibilityLabel(phoneString("conversation.audio_call"))
                .accessibilityIdentifier("conversation-audio-call")
                Button {
                    presentedGate = callsGate
                } label: {
                    LockedToolbarIcon(symbol: "video.fill")
                }
                .tint(.secondary)
                .accessibilityLabel(phoneString("conversation.video_call"))
                .accessibilityIdentifier("conversation-video-call")
            }
        }
        .sheet(item: $presentedGate) { gate in
            PhoneFeatureStatusSheet(gate: gate)
                .presentationDetents([.medium])
        }
        .sheet(item: $forwardedMessage) { message in
            PhoneForwardDestinationSheet(
                message: message,
                conversations: store.conversations.filter { store.canForward(to: $0) },
                select: { conversationID in
                    forwardedMessage = nil
                    store.forwardMessage(message.id, to: conversationID)
                }
            )
        }
        .confirmationDialog(
            "Удалить сообщение?",
            isPresented: Binding(
                get: { deletionCandidate != nil },
                set: { if !$0 { deletionCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let deletionCandidate {
                Button("Удалить для всех", role: .destructive) {
                    store.deleteMessage(deletionCandidate.id)
                    self.deletionCandidate = nil
                }
            }
            Button("Отмена", role: .cancel) {
                deletionCandidate = nil
            }
        } message: {
            Text("Сообщение будет удалено на сервере Luxora и во всех ваших сессиях.")
        }
    }

    @ViewBuilder
    private func conversationTitle(isExpanded: Bool) -> some View {
        if conversation.kind == .group || conversation.kind == .channel {
            Button(action: openCommunityProfile) {
                PhoneConversationTitle(
                    conversation: conversation,
                    isExpanded: isExpanded
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Открывает профиль, состав и роли")
            .accessibilityIdentifier("conversation-community-profile")
        } else {
            PhoneConversationTitle(
                conversation: conversation,
                isExpanded: isExpanded
            )
        }
    }

    private var reducesMotion: Bool {
        store.reduceMotion || systemReduceMotion
    }

    private var usesExpandedMessageLayout: Bool {
        dynamicTypeSize >= .xxLarge
    }

    #if DEBUG
    private func applyDebugMessageCaptureStateIfRequested() {
        guard !didApplyDebugMessageCaptureState,
              let state = ProcessInfo.processInfo.environment["LUXORA_UI_TEST_MESSAGE_CAPTURE_STATE"]
        else { return }
        didApplyDebugMessageCaptureState = true
        let conversationMessages = store.messagesByConversation[conversation.id, default: []]
        switch state {
        case "reply":
            if let message = conversationMessages.last(where: { !$0.isOutgoing }) {
                store.beginReply(to: message)
            }
        case "edit":
            if let message = conversationMessages.last(where: \.isOutgoing) {
                store.beginEditing(message)
            }
        case "pinned":
            if let message = conversationMessages.last {
                store.applyRealtimePin(
                    chatID: conversation.id,
                    messageID: message.id,
                    active: true
                )
            }
        case "forward":
            forwardedMessage = conversationMessages.last
        default:
            break
        }
    }
    #endif
}

private struct PhoneSendFailureNotice: View {
    let count: Int
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
            Text(count == 1 ? "Сообщение не отправлено" : "Не отправлено сообщений: \(count)")
                .font(.caption.weight(.semibold))
            Spacer(minLength: 4)
            Button("Повторить", action: retry)
                .font(.caption.weight(.semibold))
                .frame(minHeight: 44)
                .disabled(count == 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityIdentifier("message-send-failure")
    }
}

private struct PhoneMessageMutationFailureNotice: View {
    let failure: MessageMutationFailure
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(failure.key.kind.russianTitle) не выполнено")
                    .font(.caption.weight(.semibold))
                Text(failure.detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button("Повторить", action: retry)
                .font(.caption.weight(.semibold))
                .frame(minHeight: 44)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Закрыть")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-mutation-failure")
    }
}

private struct PhoneConversationTitle: View {
    let conversation: Conversation
    let isExpanded: Bool

    var body: some View {
        HStack(alignment: .top, spacing: isExpanded ? 11 : 8) {
            AvatarView(participant: conversation.avatar, size: isExpanded ? 44 : 32)
            VStack(alignment: .leading, spacing: isExpanded ? 3 : 0) {
                Text(conversation.title)
                    .font(isExpanded ? .headline.weight(.semibold) : .subheadline.weight(.semibold))
                    .lineLimit(isExpanded ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
                Text(statusText)
                    .font(isExpanded ? .subheadline : .caption2)
                    .foregroundStyle(conversation.isTyping ? LuxoraTheme.iris : .secondary)
                    .lineLimit(isExpanded ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: isExpanded ? .infinity : nil, alignment: .leading)
        }
        .padding(isExpanded ? 12 : 0)
        .frame(maxWidth: isExpanded ? .infinity : nil, alignment: .leading)
        .background {
            if isExpanded {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemGroupedBackground))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(conversation.title)
        .accessibilityValue(statusText)
        .accessibilityIdentifier("conversation-title")
    }

    private var statusText: String {
        conversation.isTyping ? phoneString("chats.typing") : conversation.avatar.status
    }
}

private struct LockedToolbarIcon: View {
    let symbol: String

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: symbol)
            Image(systemName: "lock.fill")
                .font(.system(size: 7, weight: .bold))
                .padding(2)
                .background(.thinMaterial, in: Circle())
                .offset(x: 5, y: 4)
        }
    }
}

private struct PhonePinnedContext: View {
    let gate: FeatureGate
    var message: ChatMessage?

    init(gate: FeatureGate, message: ChatMessage? = nil) {
        self.gate = gate
        self.message = message
    }

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(LuxoraTheme.iris)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text(phoneString("conversation.pinned"))
                    .font(.caption.weight(.semibold))
                Text(message?.text ?? "Закрепление сообщений ещё не подключено в этой сборке iPhone")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Image(systemName: message == nil ? "lock.fill" : "pin.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(message == nil ? "conversation-truth-state" : "conversation-pinned-message")
    }
}

private struct PhoneMessageBubble: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let message: ChatMessage
    let metadata: MessageRemoteMetadata
    let showsAuthorName: Bool
    let isMutationInFlight: Bool
    let retry: () -> Void
    let react: (String) -> Void
    let reply: (() -> Void)?
    let edit: (() -> Void)?
    let delete: (() -> Void)?
    let forward: (() -> Void)?
    let togglePin: (() -> Void)?

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.isOutgoing, !usesExpandedLayout {
                Spacer(minLength: 54)
            }

            VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 6) {
                    if showsAuthorName, !message.isOutgoing {
                        Text(message.author.displayName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(LuxoraTheme.iris)
                            .lineLimit(1)
                            .accessibilityHidden(true)
                    }
                    if let forwardedFrom = metadata.forwardedFrom {
                        Label(
                            "Переслано от \(forwardedFrom.senderDisplayName)",
                            systemImage: "arrowshape.turn.up.right.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(message.isOutgoing ? .white : Color(uiColor: .label))
                        .lineLimit(usesExpandedLayout ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("message-forward-provenance")
                    }

                    if let replyPreview = message.replyPreview {
                        HStack(spacing: 7) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(message.isOutgoing ? .white.opacity(0.72) : LuxoraTheme.iris)
                                .frame(width: 3)
                            Text(replyPreview)
                                .font(.caption)
                                .lineLimit(usesExpandedLayout ? nil : 2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(message.isOutgoing ? .white : Color(uiColor: .label))
                    }

                    Text(message.text)
                        .font(.body)
                        .lineLimit(nil)
                        // Oversized glyphs need breathing room from the bubble
                        // chrome, especially for Cyrillic ascenders/descenders.
                        .padding(.vertical, usesExpandedLayout ? 3 : 0)
                        .frame(
                            maxWidth: usesExpandedLayout ? .infinity : nil,
                            alignment: .leading
                        )
                        .layoutPriority(1)

                    messageMetadata
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .foregroundStyle(messageForeground)
                .background(
                    messageBackground,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .overlay(alignment: .topTrailing) {
                    if isMutationInFlight {
                        ProgressView()
                            .controlSize(.mini)
                            .padding(7)
                            .background(.ultraThinMaterial, in: Circle())
                            .padding(4)
                            .accessibilityIdentifier("message-mutation-progress")
                    }
                }

                if !message.reactions.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(message.reactions) { reaction in
                            Button {
                                react(reaction.emoji)
                            } label: {
                                Text("\(reaction.emoji) \(reaction.count)")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 4)
                                    .background(
                                        reaction.isMine
                                            ? LuxoraTheme.accent.opacity(0.28)
                                            : LuxoraTheme.accent.opacity(0.16),
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                            .disabled(
                                metadata.isDeleted
                                    || isMutationInFlight
                                    || message.delivery == .sending
                                    || message.delivery == .failed
                            )
                            .accessibilityLabel("\(reaction.emoji), реакций: \(reaction.count)")
                        }
                    }
                }

                if message.isOutgoing, message.delivery == .failed {
                    Button(action: retry) {
                        Label("Повторить отправку", systemImage: "arrow.clockwise")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("message-retry-\(message.id.uuidString.lowercased())")
                }
            }
            .frame(
                maxWidth: usesExpandedLayout ? .infinity : 310,
                alignment: message.isOutgoing ? .trailing : .leading
            )
            .layoutPriority(1)

            if !message.isOutgoing, !usesExpandedLayout {
                Spacer(minLength: 54)
            }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if !metadata.isDeleted,
               !isMutationInFlight,
               message.delivery != .sending,
               message.delivery != .failed {
                ForEach(["👍", "❤️", "🔥", "😂", "😮", "😢"], id: \.self) { emoji in
                    Button(emoji) { react(emoji) }
                }
            }
            if message.isOutgoing, message.delivery == .failed {
                Button("Повторить отправку", systemImage: "arrow.clockwise", action: retry)
            }
            if let reply {
                Button("Ответить", systemImage: "arrowshape.turn.up.left", action: reply)
                    .accessibilityIdentifier("message-action-reply")
            }
            if !metadata.isDeleted, message.delivery != .sending, message.delivery != .failed {
                Button("Копировать", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = message.text
                }
                .accessibilityIdentifier("message-action-copy")
            }
            if let edit {
                Button("Изменить", systemImage: "pencil", action: edit)
                    .accessibilityIdentifier("message-action-edit")
            }
            if let togglePin {
                Button(
                    metadata.isPinned ? "Открепить" : "Закрепить",
                    systemImage: metadata.isPinned ? "pin.slash" : "pin",
                    action: togglePin
                )
                .accessibilityIdentifier("message-action-pin")
            }
            if let forward {
                Button("Переслать", systemImage: "arrowshape.turn.up.right", action: forward)
                    .accessibilityIdentifier("message-action-forward")
            }
            if let delete {
                Divider()
                Button("Удалить", systemImage: "trash", role: .destructive, action: delete)
                    .accessibilityIdentifier("message-action-delete")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.author.displayName): \(message.text)")
        .accessibilityValue(messageAccessibilityValue)
        .accessibilityHint("Смахните вверх или вниз, чтобы выбрать действие с сообщением")
        .accessibilityActions {
            if message.isOutgoing, message.delivery == .failed {
                Button("Повторить отправку", action: retry)
            }
            if let reply {
                Button("Ответить", action: reply)
            }
            if !metadata.isDeleted, message.delivery != .sending, message.delivery != .failed {
                Button("Копировать") {
                    UIPasteboard.general.string = message.text
                }
                ForEach(["👍", "❤️", "🔥", "😂", "😮", "😢"], id: \.self) { emoji in
                    Button("Реакция \(emoji)") { react(emoji) }
                }
            }
            if let edit {
                Button("Изменить", action: edit)
            }
            if let togglePin {
                Button(metadata.isPinned ? "Открепить" : "Закрепить", action: togglePin)
            }
            if let forward {
                Button("Переслать", action: forward)
            }
            if let delete {
                Button("Удалить", role: .destructive, action: delete)
            }
        }
    }

    private var usesExpandedLayout: Bool {
        dynamicTypeSize >= .xxLarge
    }

    private var messageForeground: Color {
        message.isOutgoing ? .white : Color(uiColor: .label)
    }

    private var messageBackground: Color {
        message.isOutgoing ? LuxoraTheme.deepViolet : Color(uiColor: .secondarySystemGroupedBackground)
    }

    private var messageTime: String {
        message.sentAt.formatted(date: .omitted, time: .shortened)
    }

    private var messageMetadata: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 0)
            if message.editedAt != nil {
                Text(phoneString("conversation.edited"))
            }
            if metadata.isPinned {
                Image(systemName: "pin.fill")
            }
            Text(messageTime)
                .fixedSize(horizontal: true, vertical: true)
            if message.isOutgoing {
                Image(systemName: message.delivery.symbol)
            }
        }
        .font(.caption)
        .foregroundStyle(messageForeground)
        .accessibilityHidden(true)
    }

    private var messageAccessibilityValue: String {
        var parts = [message.isOutgoing ? "исходящее" : "входящее"]
        parts.append(message.sentAt.formatted(date: .omitted, time: .shortened))
        if message.editedAt != nil { parts.append(phoneString("conversation.edited")) }
        if metadata.isPinned { parts.append("закреплено") }
        if metadata.forwardedFrom != nil { parts.append("переслано") }
        if message.isOutgoing { parts.append(deliveryAccessibilityLabel) }
        if !message.reactions.isEmpty {
            parts.append("реакций: \(message.reactions.reduce(0) { $0 + $1.count })")
        }
        return parts.joined(separator: ", ")
    }

    private var deliveryAccessibilityLabel: String {
        switch message.delivery {
        case .sending: "отправляется"
        case .sent: "отправлено"
        case .delivered: "доставлено"
        case .read: "прочитано"
        case .failed: "ошибка отправки"
        }
    }
}

private struct PhoneForwardDestinationSheet: View {
    let message: ChatMessage
    let conversations: [Conversation]
    let select: (UUID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filteredConversations: [Conversation] {
        conversations
            .filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
            .sorted { $0.lastActivity > $1.lastActivity }
    }

    var body: some View {
        let destinations = filteredConversations

        NavigationStack {
            List {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: "arrowshape.turn.up.right.fill")
                            .foregroundStyle(LuxoraTheme.iris)
                        Text(message.text)
                            .font(.callout)
                            .lineLimit(2)
                    }
                    .accessibilityIdentifier("forward-message-preview")
                }

                Section("Выберите чат") {
                    if destinations.isEmpty {
                        ContentUnavailableView(
                            "Подходящие чаты не найдены",
                            systemImage: "bubble.left.and.exclamationmark.bubble.right"
                        )
                    } else {
                        ForEach(destinations) { conversation in
                            Button {
                                select(conversation.id)
                            } label: {
                                HStack(spacing: 12) {
                                    AvatarView(participant: conversation.avatar, size: 42)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(conversation.title)
                                            .font(.body)
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        Text(conversation.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(
                                "forward-destination-\(conversation.id.uuidString.lowercased())"
                            )
                        }
                    }
                }
            }
            .contentMargins(.bottom, 72, for: .scrollContent)
            .navigationTitle("Переслать сообщение")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Поиск чата")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("forward-destination-sheet")
    }
}

private struct PhoneNewMessageSheet: View {
    @Bindable var store: MessengerStore
    let openConversation: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var localResults: [Conversation] {
        store.conversations.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
        }
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        let loadedConversations = localResults
        let searchQuery = normalizedQuery

        NavigationStack {
            List {
                Section {
                    Label(
                        "Найдите подтверждённый контакт на сервере или откройте существующую переписку.",
                        systemImage: "person.crop.circle.badge.magnifyingglass"
                    )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                if !loadedConversations.isEmpty {
                    Section("Загруженные переписки") {
                        ForEach(loadedConversations) { conversation in
                            Button {
                                dismiss()
                                openConversation(conversation.id)
                            } label: {
                                HStack(spacing: 12) {
                                    AvatarView(participant: conversation.avatar, size: 42)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(conversation.title)
                                        Text("@\(conversation.avatar.username)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("new-message-existing-\(conversation.id.uuidString.lowercased())")
                        }
                    }
                }

                if !searchQuery.isEmpty {
                    Section("Контакты на сервере") {
                        switch store.peopleSearchState {
                        case .idle, .loading:
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Ищем контакты…")
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityIdentifier("new-message-searching")
                        case let .failed(message):
                            PhoneRemoteFailureRow(
                                title: "Поиск не выполнен",
                                detail: message,
                                retry: { Task { await store.searchKnownPeople(searchQuery) } }
                            )
                        case .loaded:
                            if store.peopleSearchResults.isEmpty {
                                Label("Подтверждённые контакты не найдены", systemImage: "person.slash")
                                    .foregroundStyle(.secondary)
                                    .accessibilityIdentifier("new-message-no-people")
                            } else {
                                ForEach(store.peopleSearchResults) { participant in
                                    Button {
                                        Task {
                                            guard let conversationID = await store.createDirectConversation(
                                                with: participant.id
                                            ) else { return }
                                            dismiss()
                                            openConversation(conversationID)
                                        }
                                    } label: {
                                        HStack(spacing: 12) {
                                            AvatarView(participant: participant, size: 42)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(participant.displayName)
                                                Text("@\(participant.username)")
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                            Spacer(minLength: 4)
                                            if store.directConversationCreationState == .loading {
                                                ProgressView()
                                            } else {
                                                Image(systemName: "chevron.right")
                                                    .font(.caption.weight(.semibold))
                                                    .foregroundStyle(.tertiary)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(store.directConversationCreationState == .loading)
                                    .accessibilityIdentifier("new-message-person-\(participant.id.uuidString.lowercased())")
                                }
                            }
                        }
                    }
                }

                if case let .failed(message) = store.directConversationCreationState {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("new-message-create-failed")
                    }
                }

                if searchQuery.isEmpty, loadedConversations.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "Чатов пока нет",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Введите имя или username подтверждённого контакта.")
                        )
                    }
                }
            }
            .searchable(text: $query, prompt: "Имя или username")
            .navigationTitle(phoneString("chats.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(phoneString("common.cancel")) { dismiss() }
                }
            }
            .task(id: searchQuery) {
                guard !searchQuery.isEmpty else {
                    await store.searchKnownPeople("")
                    return
                }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await store.searchKnownPeople(searchQuery)
            }
        }
        .accessibilityIdentifier("new-message-sheet")
    }
}

private struct PhoneSpacesView: View {
    let gate: FeatureGate
    @State private var presentedGate: FeatureGate?

    var body: some View {
        List {
            Section {
                PhoneDestinationHero(
                    symbol: "person.3.sequence.fill",
                    title: "Пространства",
                    detail: "Общие пространства для каналов, кругов и сообществ — после готовности серверной модели участников."
                )
            }
            .listRowBackground(Color.clear)

            Section("Текущая доступность") {
                FeatureGateRow(gate: gate)
            }

            Section("Целевая структура") {
                PlannedRow(symbol: "number", title: "Каналы", detail: "Текст, объявления и темы")
                PlannedRow(symbol: "person.2.fill", title: "Участники", detail: "Приглашения, роли и модерация")
                PlannedRow(symbol: "bell.badge.fill", title: "Уведомления", detail: "Настройки пространства и каналов")
            }

            Section {
                Button { presentedGate = gate } label: {
                    Label("Создать пространство", systemImage: "lock.fill")
                        .foregroundStyle(.secondary)
                }
                    .accessibilityIdentifier("spaces-create-gated")
            } footer: {
                Text("Кнопка показывает статус серверной функции и не создаёт локальные фиктивные данные.")
            }
        }
        .navigationTitle("Пространства")
        .sheet(item: $presentedGate) { presentedGate in
            PhoneFeatureStatusSheet(gate: presentedGate)
                .presentationDetents([.medium])
        }
        .accessibilityIdentifier("spaces-screen")
    }
}

private struct PhoneCallsView: View {
    let gate: FeatureGate
    @State private var presentedGate: FeatureGate?

    var body: some View {
        List {
            Section {
                PhoneDestinationHero(
                    symbol: "phone.fill",
                    title: phoneString("calls.title"),
                    detail: "Аудио- и видеозвонки включатся, когда серверный сигналинг и системные звонки iPhone будут готовы."
                )
            }
            .listRowBackground(Color.clear)

            Section("Текущая доступность") {
                FeatureGateRow(gate: gate)
            }

            Section("Системные звонки iPhone") {
                PlannedRow(symbol: "waveform", title: "Аудио и видео", detail: "Системные личные звонки на iPhone")
                PlannedRow(symbol: "rectangle.grid.2x2.fill", title: "Групповые звонки", detail: "Сетка участников, роли и качество связи")
                PlannedRow(symbol: "rectangle.inset.filled.and.person.filled", title: "Трансляция экрана", detail: "Системная передача экрана iPhone")
            }

            Section {
                Button { presentedGate = gate } label: {
                    Label(phoneString("calls.new"), systemImage: "lock.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("calls-start-gated")
            } footer: {
                Text("Luxora не создаёт фиктивную историю, пока сервер сообщает, что звонки недоступны.")
            }
        }
        .navigationTitle(phoneString("calls.title"))
        .contentMargins(.bottom, 96, for: .scrollContent)
        .sheet(item: $presentedGate) { presentedGate in
            PhoneFeatureStatusSheet(gate: presentedGate)
                .presentationDetents([.medium])
        }
        #if DEBUG
        .task {
            if ProcessInfo.processInfo.environment["LUXORA_UI_TEST_PRESENT_FEATURE_STATUS"] == "1" {
                presentedGate = gate
            }
        }
        #endif
        .accessibilityIdentifier("calls-screen")
    }
}

private struct PhoneSearchView: View {
    @Bindable var store: MessengerStore
    let searchStore: GlobalSearchStore?
    let searchGate: FeatureGate
    let openConversation: (UUID) -> Void
    let close: () -> Void

    @State private var query = ""
    @State private var scope = GlobalSearchScope.chats
    @State private var hidesRecentPeople = false

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var localResults: [Conversation] {
        store.conversations
            .filter {
                normalizedQuery.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(normalizedQuery)
                    || $0.subtitle.localizedCaseInsensitiveContains(normalizedQuery)
            }
            .filter { conversation in
                switch scope {
                case .channels: conversation.kind == .channel
                case .chats: true
                case .people, .messages, .media: false
                }
            }
            .sorted { $0.lastActivity > $1.lastActivity }
    }

    private var recentPeople: [Conversation] {
        Array(store.conversations.filter { $0.kind == .direct }.prefix(5))
    }

    var body: some View {
        let projectedResults = localResults
        let projectedRecentPeople = recentPeople

        List {
            if scope == .chats,
               normalizedQuery.isEmpty,
               !projectedRecentPeople.isEmpty,
               !hidesRecentPeople
            {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(projectedRecentPeople) { conversation in
                                Button { openConversation(conversation.id) } label: {
                                    VStack(spacing: 6) {
                                        AvatarView(participant: conversation.avatar, size: 60)
                                        Text(conversation.title)
                                            .font(.caption)
                                            .lineLimit(1)
                                            .frame(width: 60)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("search-recent-people")
                }
                .listRowInsets(.init(top: 6, leading: 10, bottom: 4, trailing: 10))
                .listRowBackground(Color.clear)
            }

            Section {
                searchRows(localResults: projectedResults)
            } header: {
                HStack {
                    Text(normalizedQuery.isEmpty ? phoneString("search.recent") : phoneString("search.results"))
                    Spacer()
                    if scope == .chats, normalizedQuery.isEmpty, !hidesRecentPeople {
                        Button(phoneString("search.clear_recent")) {
                            hidesRecentPeople = true
                        }
                        .font(.subheadline)
                        .textCase(nil)
                        .accessibilityIdentifier("search-clear-recent")
                    }
                }
            } footer: {
                Text(searchFooter)
            }
        }
        .accessibilityIdentifier("search-screen")
        .overlay {
            if showsInitialLoader {
                ProgressView("Ищем на сервере…")
                    .accessibilityIdentifier("search-loading")
            } else if scope.isRemote, normalizedQuery.isEmpty {
                ContentUnavailableView(
                    "Введите запрос",
                    systemImage: "magnifyingglass",
                    description: Text("Выберите область и начните вводить имя, сообщение или файл.")
                )
            } else if showsEmpty(localResults: projectedResults) {
                ContentUnavailableView(
                    "Ничего не найдено",
                    systemImage: "magnifyingglass",
                    description: Text("Измените запрос или область поиска.")
                )
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(0)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
        .toolbarVisibility(.hidden, for: .navigationBar)
        .toolbarVisibility(.hidden, for: .tabBar)
        .contentMargins(.bottom, 116, for: .scrollContent)
        .overlay(alignment: .bottom) {
            PhoneSearchBottomBar(query: $query, scope: $scope, close: close)
                .padding(.horizontal, 16)
                .padding(.bottom, 18)
                .offset(y: 32)
        }
        .task(id: "\(scope.rawValue)|\(normalizedQuery)") {
            guard let searchStore else { return }
            if scope.isRemote, !normalizedQuery.isEmpty {
                do {
                    try await Task.sleep(for: .milliseconds(250))
                } catch {
                    return
                }
            }
            guard !Task.isCancelled else { return }
            await searchStore.search(query: normalizedQuery, scope: scope)
        }
    }

    @ViewBuilder
    private func searchRows(localResults: [Conversation]) -> some View {
        switch scope {
        case .chats, .channels:
            ForEach(localResults) { conversation in
                Button { openConversation(conversation.id) } label: {
                    PhoneSearchResultRow(conversation: conversation)
                }
                .buttonStyle(.plain)
                .listRowInsets(.init(top: 0, leading: 14, bottom: 0, trailing: 16))
                .accessibilityIdentifier("search-result-\(conversation.id.uuidString.lowercased())")
            }
        case .people:
            if let searchStore {
                ForEach(searchStore.people) { participant in
                    Button { openParticipant(participant) } label: {
                        PhoneParticipantSearchResultRow(participant: participant)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("search-person-\(participant.id.uuidString.lowercased())")
                }
                remoteStateRows(searchStore)
            } else {
                unavailableRow
            }
        case .messages:
            if let searchStore {
                ForEach(searchStore.messages) { result in
                    Button { openConversation(result.conversationID) } label: {
                        PhoneMessageSearchResultRow(
                            result: result,
                            conversationTitle: store.conversations.first {
                                $0.id == result.conversationID
                            }?.title
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("search-message-\(result.id.uuidString.lowercased())")
                }
                remoteStateRows(searchStore)
            } else {
                unavailableRow
            }
        case .media:
            if let searchStore {
                ForEach(searchStore.files) { result in
                    PhoneFileSearchResultRow(result: result)
                        .accessibilityIdentifier("search-file-\(result.id.uuidString.lowercased())")
                }
                remoteStateRows(searchStore)
            } else {
                unavailableRow
            }
        }
    }

    @ViewBuilder
    private func remoteStateRows(_ searchStore: GlobalSearchStore) -> some View {
        if case let .failed(message) = searchStore.state {
            PhoneRemoteFailureRow(
                title: "Поиск не выполнен",
                detail: message,
                retry: { Task { await searchStore.retry() } }
            )
        }
        if searchStore.canLoadMore {
            Button {
                Task { await searchStore.loadMore() }
            } label: {
                HStack {
                    Spacer()
                    if searchStore.state == .loading {
                        ProgressView()
                    } else {
                        Text("Показать ещё")
                    }
                    Spacer()
                }
            }
            .disabled(searchStore.state == .loading)
            .accessibilityIdentifier("search-load-more")
        }
    }

    private var unavailableRow: some View {
        Label("Серверный поиск недоступен в этом сеансе", systemImage: "wifi.slash")
            .foregroundStyle(.secondary)
    }

    private func openParticipant(_ participant: Participant) {
        if let existing = store.conversations.first(where: {
            $0.kind == .direct && $0.avatar.id == participant.id
        }) {
            openConversation(existing.id)
            return
        }
        Task {
            if let conversationID = await store.createDirectConversation(with: participant.id) {
                openConversation(conversationID)
            }
        }
    }

    private var showsInitialLoader: Bool {
        guard scope.isRemote,
              !normalizedQuery.isEmpty,
              let searchStore,
              searchStore.state == .loading
        else { return false }
        return remoteResultCount(searchStore) == 0
    }

    private func showsEmpty(localResults: [Conversation]) -> Bool {
        guard !normalizedQuery.isEmpty else { return false }
        if !scope.isRemote { return localResults.isEmpty }
        guard let searchStore, searchStore.state == .loaded else { return false }
        return remoteResultCount(searchStore) == 0
    }

    private func remoteResultCount(_ searchStore: GlobalSearchStore) -> Int {
        switch scope {
        case .people: searchStore.people.count
        case .messages: searchStore.messages.count
        case .media: searchStore.files.count
        case .chats, .channels: 0
        }
    }

    private var searchFooter: String {
        switch scope {
        case .chats, .channels:
            "Поиск по уже синхронизированным чатам этого сеанса."
        case .people:
            "Сервер показывает только принятые контакты без статуса присутствия."
        case .messages:
            "\(searchGate.state.label): сервер ищет только доступные вам сообщения. Beta-0.1 не использует E2EE."
        case .media:
            "\(searchGate.state.label): результаты доступны только в разрешённых вам чатах; файлы могут иметь статус «не проверен»."
        }
    }
}

private struct PhoneSearchBottomBar: View {
    @Binding var query: String
    @Binding var scope: GlobalSearchScope
    let close: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            PhoneSearchScopeRail(selection: $scope)

            HStack(spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    TextField(phoneString("search.prompt"), text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("search-query")
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(phoneString("search.clear"))
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 48)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.secondary.opacity(0.16), lineWidth: 0.5))

                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.title2.weight(.medium))
                        .frame(width: 48, height: 48)
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay(Circle().stroke(Color.secondary.opacity(0.16), lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phoneString("common.close"))
                .accessibilityIdentifier("search-close")
            }
        }
    }
}

private struct PhoneSearchScopeRail: View {
    @Binding var selection: GlobalSearchScope

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(GlobalSearchScope.allCases) { scope in
                    Button {
                        selection = scope
                    } label: {
                        Text(scope.rawValue)
                            .font(.subheadline.weight(selection == scope ? .semibold : .regular))
                            .lineLimit(1)
                            .padding(.horizontal, 18)
                            .frame(height: 32)
                            .background {
                                if selection == scope {
                                    Capsule().fill(Color.primary.opacity(0.14))
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selection == scope ? Color.primary : Color.secondary)
                    .accessibilityAddTraits(selection == scope ? .isSelected : [])
                    .accessibilityIdentifier("search-scope-\(scope.rawValue)")
                }
            }
            .padding(3)
        }
        .scrollIndicators(.hidden)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.16), lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Области поиска")
        .accessibilityIdentifier("search-scope-rail")
    }
}

private struct PhoneSearchResultRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(participant: conversation.avatar, size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(conversation.avatar.isOnline ? phoneString("common.online").lowercased() : conversation.avatar.status)
                    .font(.callout)
                    .foregroundStyle(conversation.avatar.isOnline ? LuxoraTheme.iris : .secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 50)
        .contentShape(Rectangle())
    }
}

private struct PhoneParticipantSearchResultRow: View {
    let participant: Participant

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(participant: participant, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(participant.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text("@\(participant.username)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneMessageSearchResultRow: View {
    let result: GlobalMessageSearchResult
    let conversationTitle: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(participant: result.sender, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(conversationTitle ?? result.sender.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(result.createdAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(result.sender.displayName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(LuxoraTheme.iris)
                    .lineLimit(1)
                Text(result.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneFileSearchResultRow: View {
    let result: GlobalFileSearchResult

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(LuxoraTheme.iris.gradient, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(result.fileName)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Text("\(result.formattedSize) · \(result.mimeType)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if result.safetyStatus == "unscanned" {
                    Label("Файл не проверен", systemImage: "exclamationmark.shield.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch result.kind {
        case "image": "photo.fill"
        case "video", "video_message": "video.fill"
        case "audio", "voice": "waveform"
        default: "doc.fill"
        }
    }
}

private struct PhoneYouView: View {
    @Bindable var store: MessengerStore
    let featureMatrix: LuxoraFeatureMatrix
    let phonePasswordSettingsStore: PhonePasswordSettingsStore?
    let phoneBindingStore: PhoneBindingStore?
    let chatFoldersStore: ChatFoldersStore?
    let openRoute: (PhoneSettingsRoute) -> Void
    let openSaved: (UUID) -> Void
    let openCalls: () -> Void
    let signOut: () -> Void

    private var savedConversation: Conversation? {
        store.conversations.first(where: { $0.kind == .saved })
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    AvatarView(participant: store.currentUser, size: 94)
                    Text(store.currentUser.displayName)
                        .font(.title2.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("@\(store.currentUser.username) · Beta-0.1")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .listRowBackground(Color.clear)

            Section {
                settingsButton(
                    route: .profile,
                    symbol: "person.crop.circle.fill",
                    color: .red,
                    title: phoneString("settings.profile"),
                    value: nil,
                    identifier: "settings-profile",
                    locked: false
                )

                if let savedConversation {
                    Button {
                        openSaved(savedConversation.id)
                    } label: {
                        PhoneSettingsCompactRow(
                            symbol: "bookmark.fill",
                            color: LuxoraTheme.electricBlue,
                            title: phoneString("settings.saved"),
                            value: nil,
                            showsDisclosure: true,
                            locked: false
                        )
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .accessibilityIdentifier("you-saved-messages")
                }

                Button(action: openCalls) {
                    PhoneSettingsCompactRow(
                        symbol: "phone.fill",
                        color: .green,
                        title: phoneString("settings.recent_calls"),
                        value: nil,
                        showsDisclosure: true,
                        locked: featureMatrix.calls.state != .available
                    )
                }
                .buttonStyle(.plain)
                .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
                .accessibilityLabel("\(phoneString("settings.recent_calls")), \(featureMatrix.calls.state.label)")
                .accessibilityIdentifier("settings-recent-calls")

                settingsButton(
                    route: .devices,
                    symbol: featureMatrix.devices.symbol,
                    color: .orange,
                    title: phoneString("settings.devices"),
                    value: featureMatrix.devices.state == .limited ? "1" : featureMatrix.devices.state.label,
                    identifier: "you-settings-devices",
                    locked: featureMatrix.devices.state == .unavailable
                )

                settingsButton(
                    route: .phonePassword,
                    symbol: "key.fill",
                    color: .purple,
                    title: "Пароль входа",
                    value: phonePasswordStatusTitle,
                    identifier: "you-settings-phone-password",
                    locked: phonePasswordSettingsStore == nil
                )

                settingsButton(
                    route: .folders,
                    symbol: "folder.fill",
                    color: .cyan,
                    title: phoneString("settings.folders"),
                    value: chatFoldersStore.map {
                        "\($0.folders.count) из \(ChatFolderContract.maximumFolders) · Сервер Luxora"
                    } ?? "Сервер недоступен",
                    identifier: "you-settings-folders",
                    locked: chatFoldersStore == nil
                )
            }

            Section {
                settingsButton(
                    route: .notifications,
                    symbol: "bell.badge.fill",
                    color: .red,
                    title: phoneString("settings.notifications"),
                    value: nil,
                    identifier: "you-settings-notifications",
                    locked: featureMatrix.pushJobs.state != .available
                )
                settingsButton(
                    route: .privacy,
                    symbol: "lock.shield.fill",
                    color: .gray,
                    title: phoneString("settings.privacy"),
                    value: nil,
                    identifier: "you-settings-privacy",
                    locked: featureMatrix.securityE2EE.state != .available
                )
                settingsButton(
                    route: .data,
                    symbol: "externaldrive.fill",
                    color: .green,
                    title: phoneString("settings.data"),
                    value: nil,
                    identifier: "you-settings-data",
                    locked: featureMatrix.mediaFiles.state != .available
                )
                settingsButton(
                    route: .appearance,
                    symbol: "circle.lefthalf.filled",
                    color: .blue,
                    title: phoneString("settings.appearance"),
                    value: appearanceTitle,
                    identifier: "you-settings-appearance",
                    locked: false
                )
                settingsButton(
                    route: .power,
                    symbol: "battery.75percent",
                    color: .orange,
                    title: phoneString("settings.power"),
                    value: store.reduceMotion ? "Вкл." : "Выкл.",
                    identifier: "you-settings-power",
                    locked: false
                )
                settingsButton(
                    route: .language,
                    symbol: "globe",
                    color: .purple,
                    title: phoneString("settings.language"),
                    value: phoneString("settings.russian"),
                    identifier: "you-settings-language",
                    locked: false
                )
            }

            Section {
                settingsButton(
                    route: .plus,
                    symbol: "star.fill",
                    color: .purple,
                    title: "Luxora Plus",
                    value: nil,
                    identifier: "settings-plus",
                    locked: true
                )
                settingsButton(
                    route: .help,
                    symbol: "questionmark.bubble.fill",
                    color: .orange,
                    title: phoneString("settings.help"),
                    value: phoneString("common.beta"),
                    identifier: "you-settings-help",
                    locked: true
                )
                settingsButton(
                    route: .faq,
                    symbol: "questionmark.circle.fill",
                    color: .cyan,
                    title: phoneString("settings.faq"),
                    value: nil,
                    identifier: "settings-faq",
                    locked: true
                )
                settingsButton(
                    route: .features,
                    symbol: "lightbulb.fill",
                    color: .yellow,
                    title: phoneString("settings.features"),
                    value: phoneString("common.beta"),
                    identifier: "settings-features",
                    locked: false
                )
                settingsButton(
                    route: .about,
                    symbol: "info.circle.fill",
                    color: LuxoraTheme.iris,
                    title: phoneString("settings.about"),
                    value: phoneString("settings.beta_01"),
                    identifier: "you-settings-about",
                    locked: false
                )
            }

            Section {
                Button(phoneString("settings.sign_out"), role: .destructive, action: signOut)
                    .accessibilityIdentifier("you-sign-out")
            } footer: {
                Text("Luxora Beta-0.1 · Разработчик и владелец: Flenym")
            }
        }
        .navigationTitle(phoneString("settings.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { openRoute(.profileCode) } label: {
                    Image(systemName: "qrcode")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("QR профиля")
                .accessibilityIdentifier("settings-profile-qr")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { openRoute(.profile) } label: {
                    Image(systemName: "pencil")
                        .frame(minWidth: 44, minHeight: 44)
                }
                    .foregroundStyle(.primary)
                    .accessibilityLabel(phoneString("settings.edit"))
                    .accessibilityIdentifier("settings-edit-profile")
            }
        }
        .contentMargins(.bottom, 96, for: .scrollContent)
        // iOS 26's hard edge effect keeps colorful rows from optically
        // distorting the native floating Liquid Glass tab bar.
        .luxoraHardBottomScrollEdge()
        .accessibilityIdentifier("settings-screen")
    }

    @ViewBuilder
    private func settingsButton(
        route: PhoneSettingsRoute,
        symbol: String,
        color: Color,
        title: String,
        value: String?,
        identifier: String,
        locked: Bool
    ) -> some View {
        Button { openRoute(route) } label: {
            PhoneSettingsCompactRow(
                symbol: symbol,
                color: color,
                title: title,
                value: value,
                showsDisclosure: true,
                locked: locked
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
        .accessibilityLabel(
            [title, value, locked ? phoneString("common.unavailable") : nil]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityIdentifier(identifier)
    }

    private var appearanceTitle: String {
        switch store.preferredAppearance {
        case "light": "Светлое"
        case "dark": "Тёмное"
        default: "Системное"
        }
    }

    private var phonePasswordStatusTitle: String? {
        guard let status = phonePasswordSettingsStore?.status else { return nil }
        return status.enabled ? "Вкл." : "Выкл."
    }
}

private extension View {
    @ViewBuilder
    func luxoraHardBottomScrollEdge() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectStyle(.hard, for: .bottom)
        } else {
            self
        }
    }
}

private struct PhoneSettingsCompactRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let symbol: String
    let color: Color
    let title: String
    let value: String?
    let showsDisclosure: Bool
    let locked: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.primary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
                if dynamicTypeSize.isAccessibilitySize, let value {
                    Text(value)
                        .font(.callout)
                        .foregroundStyle(.primary.opacity(0.72))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if !dynamicTypeSize.isAccessibilitySize, let value {
                Text(value)
                    .font(.callout)
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineLimit(1)
            }
            if locked {
                Image(systemName: "lock.fill")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if showsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneSettingsRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let symbol: String
    let color: Color
    let title: String
    let detail: String
    let value: String
    var showsDisclosure = true

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                    .fixedSize(horizontal: false, vertical: true)
                if dynamicTypeSize.isAccessibilitySize {
                    Text(value)
                        .font(.caption)
                        .foregroundStyle(.primary.opacity(0.72))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            if !dynamicTypeSize.isAccessibilitySize {
                Text(value)
                    .font(.caption)
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineLimit(1)
            }
            if showsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneFoldersSettingsView: View {
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Bindable var store: MessengerStore

    private var summaries: [PhoneFolderSummary] {
        PhoneFolderSummary.make(from: store.conversations)
    }

    var body: some View {
        let folderSummaries = summaries

        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 10) {
                    Text("🗂️")
                        .font(.system(size: 92))
                        .accessibilityHidden(true)
                    Text("Быстро переключайтесь между группами уже загруженных чатов.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 18)

                VStack(spacing: 0) {
                    ForEach(Array(folderSummaries.enumerated()), id: \.element.folder) { index, summary in
                        Button {
                            withAnimation(reducesMotion ? nil : .snappy(duration: 0.22)) {
                                store.selectedFolder = summary.folder
                            }
                        } label: {
                            PhoneFolderSelectionRow(
                                summary: summary,
                                isSelected: store.selectedFolder == summary.folder
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("folders-option-\(summary.folder.rawValue)")
                        if index != folderSummaries.indices.last {
                            Divider().padding(.leading, 56)
                        }
                    }
                }
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )

                VStack(alignment: .leading, spacing: 12) {
                    Label("Локальный фильтр Beta-0.1", systemImage: "iphone")
                        .font(.headline)
                    Text("Выбор применяется сразу к вкладке «Чаты». Создание, удаление и синхронизация собственных папок появятся после отдельного серверного API.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button("Показать все чаты") {
                        store.selectedFolder = .all
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.selectedFolder == .all)
                    .accessibilityIdentifier("folders-reset-all")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Сбросить") { store.selectedFolder = .all }
                    .disabled(store.selectedFolder == .all)
                    .accessibilityIdentifier("folders-reset-toolbar")
            }
        }
        .navigationTitle(phoneString("settings.folders"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-folders-screen")
    }

    private var reducesMotion: Bool {
        store.reduceMotion || systemReduceMotion
    }
}

private struct PhoneFolderSelectionRow: View {
    let summary: PhoneFolderSummary
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(color.gradient, in: Circle())
            Text(summary.folder.title)
                .foregroundStyle(.primary)
            Spacer()
            Text("\(summary.conversationCount)")
                .foregroundStyle(.secondary)
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isSelected ? LuxoraTheme.iris : Color.secondary.opacity(0.4))
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 54)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(summary.folder.title), чатов: \(summary.conversationCount)")
        .accessibilityValue(isSelected ? "Выбрано" : "Не выбрано")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var symbol: String {
        switch summary.folder {
        case .all: "tray.full.fill"
        case .archived: "archivebox.fill"
        case .unread: "circlebadge.fill"
        case .personal: "person.fill"
        case .work: "briefcase.fill"
        case .groups: "person.3.fill"
        case .channels: "megaphone.fill"
        case .saved: "bookmark.fill"
        }
    }

    private var color: Color {
        switch summary.folder {
        case .all: LuxoraTheme.electricBlue
        case .archived: .gray
        case .unread: .orange
        case .personal: .cyan
        case .work: .purple
        case .groups: .green
        case .channels: .pink
        case .saved: LuxoraTheme.iris
        }
    }
}

private struct PhoneDevicesSettingsView: View {
    let gate: FeatureGate
    let signOut: () -> Void

    var body: some View {
        List {
            Section("Текущая доступность") {
                FeatureGateRow(gate: gate)
            }
            Section("Этот сеанс") {
                PlannedRow(
                    symbol: "iphone",
                    title: "Этот iPhone",
                    detail: "Текущий сеанс можно завершить через сервер",
                    status: phoneString("common.current")
                )
                Button("Завершить текущий сеанс", role: .destructive, action: signOut)
                    .accessibilityIdentifier("devices-revoke-current")
            }
            Section("Следующие этапы") {
                PlannedRow(symbol: "qrcode.viewfinder", title: "Подключить устройство", detail: "QR-подтверждение ещё не включено")
                PlannedRow(symbol: "exclamationmark.shield.fill", title: "Проверка компрометации", detail: "Сервер пока не поддерживает удалённый список устройств")
            }
            Section {
                Text("Реально подключено только завершение текущего сеанса. Luxora не создаёт локальный список устройств, которого не вернул сервер.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.devices"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-devices-screen")
    }
}

private struct PhonePowerSettingsView: View {
    @Bindable var store: MessengerStore

    var body: some View {
        Form {
            Section("Доступно на iPhone") {
                Toggle("Уменьшить анимацию интерфейса", isOn: $store.reduceMotion)
                Text("Luxora также учитывает системную настройку «Уменьшение движения».")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Запланировано") {
                PlannedRow(symbol: "arrow.down.circle", title: "Автозагрузка медиа", detail: "Появится после готовности надёжного хранилища медиа")
                PlannedRow(symbol: "waveform.path.ecg", title: "Экономия во время звонков", detail: "Требует готовых системных звонков iPhone")
                PlannedRow(symbol: "clock.arrow.circlepath", title: "Фоновая синхронизация", detail: "Требует push-уведомлений и надёжных фоновых задач")
            }
        }
        .navigationTitle(phoneString("settings.power"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-power-screen")
    }
}

private struct PhoneTargetSettingsView: View {
    let title: String
    let symbol: String
    let detail: String

    var body: some View {
        List {
            Section {
                PhoneDestinationHero(symbol: symbol, title: title, detail: detail)
            }
            .listRowBackground(Color.clear)
            Section("Статус") {
                Label(phoneString("common.planned"), systemImage: "lock.fill")
                    .foregroundStyle(.secondary)
            }
            Section {
                Text("Экран показывает целевое место в структуре настроек, но не имитирует готовую серверную функцию.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PhoneFeaturesSettingsView: View {
    let featureMatrix: LuxoraFeatureMatrix

    var body: some View {
        List {
            Section("Beta-0.1") {
                ForEach(featureMatrix.allSections) { gate in
                    FeatureGateRow(gate: gate)
                }
            }
            Section {
                Text("Это фактический список возможностей текущего сервера, а не рекламный список обещаний.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.features"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-features-screen")
    }
}

private struct PhoneGateSettingsView: View {
    let title: String
    let gate: FeatureGate
    let planned: [(symbol: String, title: String, detail: String)]

    var body: some View {
        List {
            Section("Текущая доступность") {
                FeatureGateRow(gate: gate)
            }
            Section("Покрытие") {
                ForEach(Array(planned.enumerated()), id: \.element.title) { _, item in
                    PlannedRow(symbol: item.symbol, title: item.title, detail: item.detail)
                }
            }
            Section {
                Text("Luxora не показывает функцию как работающую, пока сервер её не поддерживает.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-gate-\(gate.id)-screen")
    }
}

private struct PhoneNotificationsSettingsView: View {
    let pushGate: FeatureGate
    let settingsStore: NotificationSettingsStore?
    let registrationStore: PushRegistrationStore?
    let synchronizeAuthorization: (Bool) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var permissions = PhoneSystemPermissionSnapshot.loading
    @State private var isRequesting = false

    var body: some View {
        List {
            Section("Доставка") {
                FeatureGateRow(gate: pushGate)
                if let registrationStore {
                    PhonePushRegistrationRow(store: registrationStore)
                } else {
                    LabeledContent("Токен устройства", value: "Нет сеанса")
                        .foregroundStyle(.secondary)
                }
            }
            Section("Разрешение iPhone") {
                PhoneSystemPermissionRow(
                    title: "Уведомления",
                    symbol: "bell.badge.fill",
                    state: permissions.notifications
                )
                if permissions.notifications == .notRequested {
                    Button(isRequesting ? "Запрашиваем…" : "Разрешить уведомления") {
                        Task { await requestNotifications() }
                    }
                    .disabled(isRequesting)
                    .accessibilityIdentifier("notifications-request-permission")
                }
                PhoneSystemSettingsButton()
            }

            if let settingsStore {
                PhoneNotificationPreferencesSections(store: settingsStore)
            } else {
                Section("Настройки Luxora") {
                    ContentUnavailableView(
                        "Нет авторизованного сеанса",
                        systemImage: "bell.slash",
                        description: Text("Войдите, чтобы синхронизировать настройки уведомлений.")
                    )
                }
            }

            Section {
                Text("Luxora хранит токен зашифрованно и не возвращает его приложению. Предпросмотр по умолчанию скрыт. Реальная доставка APNs для Beta-0.1 остаётся выключена серверным флагом до подключения провайдера.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.notifications"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-notifications-screen")
        .task {
            await refreshPermissions()
            await settingsStore?.refresh()
            await registrationStore?.refresh()
        }
        .refreshable {
            await refreshPermissions()
            await settingsStore?.refresh(force: true)
            await registrationStore?.refresh(force: true)
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task { await refreshPermissions() }
        }
    }

    private func requestNotifications() async {
        isRequesting = true
        await PhoneSystemPermissionActions.requestNotifications()
        await refreshPermissions()
        isRequesting = false
    }

    private func refreshPermissions() async {
        permissions = await PhoneSystemPermissionSnapshot.current()
        switch permissions.notifications {
        case .allowed, .limited:
            synchronizeAuthorization(true)
            UIApplication.shared.registerForRemoteNotifications()
        case .denied, .restricted:
            synchronizeAuthorization(false)
        case .notRequested:
            break
        }
    }
}

private struct PhonePushRegistrationRow: View {
    @Bindable var store: PushRegistrationStore

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.state == .loading {
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("notifications-push-registration-status")
    }

    private var title: String {
        switch store.state {
        case .loading: "Синхронизация токена"
        case .failed: "Токен не синхронизирован"
        case .idle, .loaded:
            store.registration == nil ? "Ожидаем токен iPhone" : "Токен зарегистрирован"
        }
    }

    private var detail: String {
        switch store.state {
        case let .failed(message):
            return message
        case .loading:
            return "Токен не показывается и не записывается в журналы."
        case .idle, .loaded:
            if let registration = store.registration {
                return registration.environment == .production
                    ? "Среда App Store · защищённая серверная запись"
                    : "Среда разработки · защищённая серверная запись"
            }
            return "Выдаётся iOS после разрешения уведомлений."
        }
    }

    private var symbol: String {
        if case .failed = store.state { return "exclamationmark.triangle.fill" }
        return store.registration == nil ? "iphone.badge.exclamationmark" : "checkmark.shield.fill"
    }

    private var color: Color {
        if case .failed = store.state { return .orange }
        return store.registration == nil ? LuxoraTheme.iris : LuxoraTheme.success
    }
}

private struct PhoneNotificationPreferencesSections: View {
    @Bindable var store: NotificationSettingsStore

    var body: some View {
        if let settings = store.settings {
            Section("События") {
                settingToggle(
                    "Личные сообщения",
                    symbol: "message.badge.filled.fill",
                    value: settings.messageAlerts,
                    identifier: "notifications-message-alerts"
                ) { NotificationSettingsPatch(messageAlerts: $0) }
                settingToggle(
                    "Запросы на переписку",
                    symbol: "person.crop.circle.badge.questionmark",
                    value: settings.messageRequestAlerts,
                    identifier: "notifications-request-alerts"
                ) { NotificationSettingsPatch(messageRequestAlerts: $0) }
                settingToggle(
                    "Упоминания и ответы",
                    symbol: "at",
                    value: settings.mentionAlerts,
                    identifier: "notifications-mention-alerts"
                ) { NotificationSettingsPatch(mentionAlerts: $0) }
            }

            Section("Оформление") {
                settingToggle(
                    "Звук",
                    symbol: "speaker.wave.2.fill",
                    value: settings.sound,
                    identifier: "notifications-sound"
                ) { NotificationSettingsPatch(sound: $0) }
                settingToggle(
                    "Счётчик на иконке",
                    symbol: "app.badge.fill",
                    value: settings.badge,
                    identifier: "notifications-badge"
                ) { NotificationSettingsPatch(badge: $0) }

                Picker(
                    "Предпросмотр",
                    selection: Binding(
                        get: { settings.previewMode },
                        set: { previewMode in
                            Task { await store.update(.init(previewMode: previewMode)) }
                        }
                    )
                ) {
                    ForEach(NotificationPreviewMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .disabled(isSaving)
                .accessibilityIdentifier("notifications-preview-mode")
            }

            if case let .failed(message) = store.mutationState {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("notifications-settings-error")
                    Button("Повторить загрузку") {
                        store.clearMutationFailure()
                        Task { await store.refresh(force: true) }
                    }
                }
            }
        } else {
            Section("Настройки Luxora") {
                switch store.loadState {
                case .idle, .loading:
                    HStack {
                        ProgressView()
                        Text("Загружаем настройки с сервера…")
                            .foregroundStyle(.secondary)
                    }
                case let .failed(message):
                    Label(message, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.orange)
                    Button("Повторить") { Task { await store.refresh(force: true) } }
                        .accessibilityIdentifier("notifications-settings-retry")
                case .loaded:
                    ContentUnavailableView(
                        "Настройки недоступны",
                        systemImage: "bell.slash",
                        description: Text("Сервер не вернул состояние уведомлений.")
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func settingToggle(
        _ title: String,
        symbol: String,
        value: Bool,
        identifier: String,
        patch: @escaping (Bool) -> NotificationSettingsPatch
    ) -> some View {
        Toggle(
            isOn: Binding(
                get: { value },
                set: { newValue in Task { await store.update(patch(newValue)) } }
            )
        ) {
            Label(title, systemImage: symbol)
        }
        .disabled(isSaving)
        .accessibilityIdentifier(identifier)
    }

    private var isSaving: Bool {
        store.mutationState == .loading
    }
}

private struct PhonePrivacySettingsView: View {
    @Bindable var store: MessengerStore
    let featureMatrix: LuxoraFeatureMatrix

    @Environment(\.scenePhase) private var scenePhase
    @State private var permissions = PhoneSystemPermissionSnapshot.loading

    var body: some View {
        List {
            Section("Защита учётной записи") {
                FeatureGateRow(gate: featureMatrix.identityAccess)
                FeatureGateRow(gate: featureMatrix.devices)
            }
            Section("Доверие к содержимому") {
                FeatureGateRow(gate: featureMatrix.securityE2EE)
            }
            Section("Кто может найти и написать") {
                if let settings = store.privacySettings {
                    Toggle(
                        "Находить меня по точному username",
                        isOn: Binding(
                            get: { settings.usernameDiscoverable },
                            set: { store.updatePrivacySettings(usernameDiscoverable: $0) }
                        )
                    )
                    .disabled(store.privacySettingsState == .loading)
                    .accessibilityIdentifier("privacy-username-discoverable")

                    Picker(
                        "Запросы на переписку",
                        selection: Binding(
                            get: { settings.messageRequests },
                            set: { store.updatePrivacySettings(messageRequests: $0) }
                        )
                    ) {
                        ForEach(MessageRequestPolicy.allCases) { policy in
                            Text(policy.russianTitle).tag(policy)
                        }
                    }
                    .disabled(store.privacySettingsState == .loading)
                    .accessibilityIdentifier("privacy-message-requests-policy")
                } else if store.privacySettingsState == .loading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Загружаем настройки…")
                            .foregroundStyle(.secondary)
                    }
                } else if !store.supportsPrivacySettings {
                    Label("Серверные настройки недоступны", systemImage: "lock.fill")
                        .foregroundStyle(.secondary)
                }

                if store.privacySettingsState == .loading, store.privacySettings != nil {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Подтверждаем изменение на сервере…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("privacy-settings-saving")
                }

                if store.privacySettingsState == .loaded, store.privacySettings != nil {
                    Label("Сохранено на сервере", systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                        .accessibilityIdentifier("privacy-settings-confirmed")
                }

                if case let .failed(message) = store.privacySettingsState {
                    PhoneRemoteFailureRow(
                        title: "Настройки не сохранены",
                        detail: message,
                        retry: {
                            if store.privacySettings == nil {
                                Task { await store.loadPrivacySettings(force: true) }
                            } else {
                                store.retryPrivacySettingsUpdate()
                            }
                        }
                    )
                }

                Text("Удаление входящего запроса остаётся приватным: отправитель не получает сигнал о просмотре или удалении.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Разрешения этого iPhone") {
                PhoneSystemPermissionRow(title: "Контакты", symbol: "person.crop.circle", state: permissions.contacts)
                PhoneSystemPermissionRow(title: "Камера", symbol: "camera.fill", state: permissions.camera)
                PhoneSystemPermissionRow(title: "Микрофон", symbol: "mic.fill", state: permissions.microphone)
                PhoneSystemPermissionRow(title: "Фото", symbol: "photo.fill", state: permissions.photos)
                PhoneSystemSettingsButton()
            }
            Section("Факты для Beta-0.1") {
                Label("Содержимое облачного предпросмотра доступно серверу.", systemImage: "icloud.fill")
                Label("Luxora не заявляет о сквозном шифровании.", systemImage: "lock.open.fill")
                Label("Выход и завершение текущего сеанса подключены.", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .font(.callout)
        }
        .navigationTitle(phoneString("settings.privacy"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-privacy-screen")
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] == "1",
               !store.supportsPrivacySettings {
                store.installDebugMessageRequestFixture()
            }
            #endif
            await store.loadPrivacySettings()
            await refreshPermissions()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task { await refreshPermissions() }
        }
    }

    private func refreshPermissions() async {
        permissions = await PhoneSystemPermissionSnapshot.current()
    }
}

private struct PhoneDataSettingsView: View {
    let featureMatrix: LuxoraFeatureMatrix

    var body: some View {
        List {
            Section("Медиа и файлы") {
                FeatureGateRow(gate: featureMatrix.mediaFiles)
            }
            Section("Поиск") {
                FeatureGateRow(gate: featureMatrix.search)
            }
            Section("Текущее хранение") {
                LabeledContent("История сообщений", value: "Этот сеанс")
                LabeledContent("Надёжное хранение без сети", value: "Не включено")
                LabeledContent("Автозагрузка медиа", value: "Не включена")
            }
            Section {
                Text("Очистка памяти появится вместе с долговечным кэшем и загрузкой медиа. Эта сборка не предлагает удалить данные, которые она не сохраняла.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.data"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-data-screen")
    }
}

private struct PhoneAppearanceSettingsView: View {
    @Bindable var store: MessengerStore

    var body: some View {
        Form {
            Section("Тема") {
                Picker("Оформление", selection: $store.preferredAppearance) {
                    Text("Системная").tag("system")
                    Text("Светлая").tag("light")
                    Text("Тёмная").tag("dark")
                }
                .pickerStyle(.segmented)
            }
            Section("Движение") {
                Toggle("Уменьшить анимацию интерфейса", isOn: $store.reduceMotion)
                Text("Luxora также учитывает системную настройку iOS «Уменьшение движения».")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Предпросмотр") {
                HStack(spacing: 10) {
                    Circle().fill(LuxoraTheme.deepViolet).frame(width: 22, height: 22)
                    Circle().fill(LuxoraTheme.violet).frame(width: 22, height: 22)
                    Circle().fill(LuxoraTheme.iris).frame(width: 22, height: 22)
                    Text("Фиолетовый Luxora")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(phoneString("settings.appearance"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-appearance-screen")
    }
}

private struct PhoneLanguageSettingsView: View {
    var body: some View {
        List {
            Section("Текущий язык") {
                HStack {
                    Label(phoneString("settings.russian"), systemImage: "checkmark.circle.fill")
                    Spacer()
                    Text("Beta-0.1").foregroundStyle(.secondary)
                }
            }
            Section("Другие языки") {
                PlannedRow(symbol: "textformat.abc", title: "Дополнительные языки", detail: "Требуют полного перевода и проверки критичных строк")
                PlannedRow(symbol: "textformat.right.to.left", title: "Письмо справа налево", detail: "Требует отдельной проверки геометрии интерфейса")
            }
            Section {
                Text("Русский — язык приложения по умолчанию. Переключение появится только после проверки каждого перевода, важного для безопасности.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.language"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-language-screen")
    }
}

private struct PhoneHelpSettingsView: View {
    var body: some View {
        List {
            Section("Поддержка Beta") {
                PhoneSettingsRow(
                    symbol: "exclamationmark.bubble.fill",
                    color: .orange,
                    title: "Сообщить о проблеме",
                    detail: "Отправка из приложения ещё не подключена",
                    value: phoneString("common.locked"),
                    showsDisclosure: false
                )
                PhoneSettingsRow(
                    symbol: "shield.lefthalf.filled",
                    color: .red,
                    title: "Жалоба по безопасности",
                    detail: "Серверный процесс есть, нативный экран ожидается",
                    value: phoneString("common.locked"),
                    showsDisclosure: false
                )
            }
            Section("Владелец") {
                LabeledContent("Разработчик и владелец", value: "Flenym")
                LabeledContent("Версия", value: "Beta-0.1")
            }
            Section {
                Text("Ссылки поддержки появятся только вместе с контролируемым каналом обращений, правилами ответа и уведомлением о конфиденциальности.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.help"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-help-screen")
    }
}

private struct PhoneAboutSettingsView: View {
    let featureMatrix: LuxoraFeatureMatrix

    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    LuxoraLogoView(size: 76)
                    Text("Luxora")
                        .font(.title2.weight(.bold))
                    Text("Beta-0.1")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            Section("Продукт") {
                LabeledContent("Разработчик и владелец", value: "Flenym")
                LabeledContent("Клиент", value: "Основа для iPhone")
                LabeledContent("Профиль доверия", value: "Облачный предпросмотр")
            }
            Section("Подключено сейчас") {
                FeatureGateRow(gate: featureMatrix.chats)
                FeatureGateRow(gate: featureMatrix.realtime)
            }
            Section {
                Text("Экран честно показывает возможности сервера и реализации для iPhone. Он не означает, что все запланированные функции мессенджера готовы.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.about"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-about-screen")
    }
}

private struct PhoneDestinationHero: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 50, height: 50)
                .background(LuxoraTheme.brandGradient, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct PlannedRow: View {
    let symbol: String
    let title: String
    let detail: String
    let status: String

    init(symbol: String, title: String, detail: String, status: String = phoneString("common.planned")) {
        self.symbol = symbol
        self.title = title
        self.detail = detail
        self.status = status
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(LuxoraTheme.iris)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        Text(title).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(status)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold))
                        Text(status)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct PhoneFeatureStatusSheet: View {
    let gate: FeatureGate
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: gate.symbol)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(LuxoraTheme.brandGradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                Text(gate.title)
                    .font(.title2.weight(.bold))
                Text(gate.state.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(LuxoraTheme.iris)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(LuxoraTheme.accent.opacity(0.14), in: Capsule())
                Text(gate.detail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(phoneString("feature.explanation"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(22)
            .navigationTitle(phoneString("feature.status"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(phoneString("common.done")) { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("feature-status-sheet")
    }
}

struct FeatureGateRow: View {
    let gate: FeatureGate

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: gate.symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(stateColor)
                .frame(width: 28, height: 28)
                .background(stateColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        Text(gate.title)
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 6)
                        Text(gate.state.label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(stateColor)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(gate.title)
                            .font(.subheadline.weight(.semibold))
                        Text(gate.state.label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(stateColor)
                    }
                }
                Text(gate.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(gate.title), \(gate.state.label), \(gate.detail)")
        .accessibilityIdentifier("feature-\(gate.id)")
    }

    private var stateColor: Color {
        switch gate.state {
        case .available: LuxoraTheme.success
        case .limited: LuxoraTheme.accent
        case .unavailable: .secondary
        case .checking: LuxoraTheme.electricBlue
        }
    }
}
#endif

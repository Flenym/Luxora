#if os(iOS)
import SwiftUI
import UIKit

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
    private let signOut: () -> Void

    @State private var selectedTab: PhoneTab
    @State private var contactsPath: [PhoneContactRoute]
    @State private var chatsPath: [PhoneChatRoute]
    @State private var settingsPath: [PhoneSettingsRoute]
    @State private var didApplyDebugRoute = false

    public init(
        store: MessengerStore,
        featureMatrix: LuxoraFeatureMatrix,
        initialDestination: LuxoraPhoneInitialDestination = .inbox,
        signOut: @escaping () -> Void = {}
    ) {
        self.store = store
        self.featureMatrix = featureMatrix
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
                        openSpaces: { chatsPath.append(.spaces) },
                        openEdit: { chatsPath.append(.edit) }
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
                                    securityGate: featureMatrix.securityE2EE
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
                            PhoneSpacesView(gate: featureMatrix.communities)
                                .toolbarVisibility(.hidden, for: .tabBar)
                        case .edit:
                            PhoneEditChatsView(
                                store: store,
                                storiesGate: featureMatrix.stories
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

    @ViewBuilder
    private func settingsDestination(_ route: PhoneSettingsRoute) -> some View {
        switch route {
        case .folders:
            PhoneFoldersSettingsView(store: store)
        case .profile:
            PhoneOwnProfileView(
                participant: store.currentUser,
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
            PhoneDevicesSettingsView(
                gate: featureMatrix.devices,
                signOut: signOut
            )
        case .notifications:
            PhoneNotificationsSettingsView(pushGate: featureMatrix.pushJobs)
        case .privacy:
            PhonePrivacySettingsView(featureMatrix: featureMatrix)
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
        guard !didApplyDebugRoute else { return }
        didApplyDebugRoute = true

        let environment = ProcessInfo.processInfo.environment
        if let rawFolder = environment["LUXORA_UI_TEST_INITIAL_FOLDER"],
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
    case spaces
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

                        ForEach(contactSections) { section in
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
                    availableLetters: Set(contactSections.map(\.letter))
                ) { letter in
                    withAnimation(.snappy(duration: 0.22)) {
                        proxy.scrollTo(PhoneContactSection.anchorID(for: letter), anchor: .top)
                    }
                }
                .padding(.top, 50)
                .padding(.trailing, 1)
            }
        }
        .overlay {
            if filteredContacts.isEmpty {
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
        store.conversations
            .filter { conversation in
                switch store.selectedFolder {
                case .all: true
                case .unread: conversation.unreadCount > 0
                case .personal: conversation.folder == "personal"
                case .work: conversation.folder == "work"
                case .groups: conversation.kind == .group
                case .channels: conversation.kind == .channel
                case .saved: conversation.kind == .saved
                }
            }
            .filter { conversation in
                query.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(query)
                    || conversation.subtitle.localizedCaseInsensitiveContains(query)
            }
            .sorted { lhs, rhs in
                if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
                return lhs.lastActivity > rhs.lastActivity
            }
    }

    var body: some View {
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
                InboxFolderStrip(
                    selection: $store.selectedFolder,
                    conversations: store.conversations,
                    requestRemoval: { _ in presentedGate = folderEditingGate }
                )
                    .listRowSeparator(.hidden)
                    .listRowInsets(.init(top: 1, leading: 0, bottom: 4, trailing: 0))
            }

            Section {
                ForEach(visibleConversations) { conversation in
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
            if visibleConversations.isEmpty {
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
    @Bindable var store: MessengerStore
    let storiesGate: FeatureGate
    let securityGate: FeatureGate
    let openConversation: (UUID) -> Void
    let openSpaces: () -> Void
    let openEdit: () -> Void

    @State private var query = ""
    @State private var isComposing = false
    @State private var presentedGate: FeatureGate?

    private var visibleConversations: [Conversation] {
        store.conversations
            .filter { conversation in
                switch store.selectedFolder {
                case .all: true
                case .unread: conversation.unreadCount > 0
                case .personal: conversation.folder == "personal"
                case .work: conversation.folder == "work"
                case .groups: conversation.kind == .group
                case .channels: conversation.kind == .channel
                case .saved: conversation.kind == .saved
                }
            }
            .filter { conversation in
                query.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(query)
                    || conversation.subtitle.localizedCaseInsensitiveContains(query)
            }
            .sorted(by: conversationOrder)
    }

    var body: some View {
        List {
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

            if showsStatusRail {
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
                InboxFolderStrip(selection: $store.selectedFolder, conversations: store.conversations)
                    .listRowSeparator(.hidden)
                    .listRowInsets(.init(top: 2, leading: 0, bottom: 5, trailing: 0))
            }

            Section {
                ForEach(visibleConversations) { conversation in
                    Button {
                        openConversation(conversation.id)
                    } label: {
                        PhoneConversationRow(conversation: conversation)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(.init(top: 1, leading: 16, bottom: 1, trailing: 12))
                    .accessibilityIdentifier("inbox-row-\(conversation.id.uuidString.lowercased())")
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await store.refreshConversations()
        }
        .overlay {
            if visibleConversations.isEmpty {
                inboxEmptyState
            }
        }
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: phoneString("chats.search")
        )
        .navigationTitle(phoneString("chats.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(phoneString("chats.edit_short"), action: openEdit)
                    .accessibilityLabel(phoneString("chats.edit"))
                    .accessibilityIdentifier("chats-edit")
            }
            ToolbarItem(placement: .principal) {
                PhoneChatsTitleStack(
                    conversations: showsStatusRail ? [] : Array(store.conversations.prefix(3))
                )
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(phoneString("feature.security.title"), systemImage: "shield") {
                    presentedGate = securityGate
                }
                .accessibilityIdentifier("chats-security-gated")
                Button(phoneString("chats.spaces"), systemImage: "person.3.fill", action: openSpaces)
                    .accessibilityIdentifier("chats-spaces")
                Button(phoneString("chats.new"), systemImage: "square.and.pencil") {
                    isComposing = true
                }
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

    private func conversationOrder(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
        return lhs.lastActivity > rhs.lastActivity
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
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(phoneString("chats.title"))
        .accessibilityIdentifier("chats-title-stack")
    }
}

private struct InboxFolderStrip: View {
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
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(folders) { folder in
                    InboxFolderChip(
                        folder: folder,
                        isSelected: selection == folder,
                        unreadCount: unreadCount,
                        removalAction: requestRemoval.map { requestRemoval in
                            { requestRemoval(folder) }
                        }
                    ) {
                        withAnimation(.snappy(duration: 0.22)) {
                            selection = folder
                            scrollPosition = folder
                        }
                    }
                    .id(folder)
                }
            }
            .scrollTargetLayout()
        }
        .frame(height: 40)
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
            withAnimation(.snappy(duration: 0.22)) {
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
        withAnimation(.snappy(duration: 0.22)) {
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
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityValue(isSelected ? phoneString("folders.selected") : "")
            .accessibilityIdentifier("inbox-folder-\(folder.rawValue)")

            if let removalAction, folder != .all {
                Button(action: removalAction) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 25, height: 30)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(format: phoneString("folders.remove_unavailable"), folder.title))
                .accessibilityIdentifier("folder-remove-\(folder.rawValue)-gated")
            }
        }
        .foregroundStyle(isSelected ? .white : .secondary)
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
    let currentUser: Participant
    let conversations: [Conversation]
    let gate: FeatureGate

    @State private var scrollPosition: UUID?
    @State private var presentedGate: FeatureGate?

    private var items: [StatusRailItem] {
        let mine = StatusRailItem(participant: currentUser, isMine: true)
        let contacts = conversations
            .filter { $0.kind == .direct }
            .map { StatusRailItem(participant: $0.avatar, isMine: false) }
        return [mine] + contacts
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 4) {
                ForEach(items) { item in
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
                                .font(.caption2)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity)
                        }
                        .frame(width: 72)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "\(item.isMine ? phoneString("stories.mine") : item.participant.displayName), \(phoneString("stories.unavailable"))"
                    )
                    .accessibilityHint(gate.detail)
                    .accessibilityIdentifier("status-item-\(item.id.uuidString.lowercased())")
                    .id(item.id)
                }
            }
            .scrollTargetLayout()
        }
        .frame(height: 88)
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
                scrollPosition = items.first?.id
            }
        }
    }

    private func move(by offset: Int) {
        guard !items.isEmpty else { return }
        let current = scrollPosition ?? items[0].id
        let index = items.firstIndex(where: { $0.id == current }) ?? 0
        let targetIndex = min(max(index + offset, items.startIndex), items.index(before: items.endIndex))
        withAnimation(.snappy(duration: 0.22)) {
            scrollPosition = items[targetIndex].id
        }
    }
}

private struct StatusRailItem: Identifiable {
    let participant: Participant
    let isMine: Bool

    var id: UUID { participant.id }
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
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(participant: conversation.avatar, size: 54)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Text(conversation.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(conversation.lastActivity, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                HStack(spacing: 6) {
                    Text(conversation.isTyping ? phoneString("chats.typing") : conversation.subtitle)
                        .font(.callout)
                        .foregroundStyle(conversation.isTyping ? LuxoraTheme.iris : .secondary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if conversation.isMuted {
                        Image(systemName: "speaker.slash.fill")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(LuxoraTheme.accent, in: Capsule())
                    } else if conversation.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(conversation.title), непрочитанных: \(conversation.unreadCount)")
    }
}

private struct PhoneDirectConversationView: View {
    @Bindable var store: MessengerStore
    let conversation: Conversation
    let callsGate: FeatureGate
    let mediaGate: FeatureGate
    let securityGate: FeatureGate

    @State private var presentedGate: FeatureGate?

    private var messages: [ChatMessage] {
        store.messagesByConversation[conversation.id, default: []]
    }

    private var messageState: RemoteContentState {
        store.messageState(for: conversation.id)
    }

    private var failedMessages: [ChatMessage] {
        messages.filter { $0.isOutgoing && $0.delivery == .failed }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    PhonePinnedContext(gate: securityGate)

                    if !failedMessages.isEmpty {
                        PhoneSendFailureNotice(count: failedMessages.count) {
                            failedMessages.forEach { store.retryMessage($0.id) }
                        }
                    }

                    if case let .failed(message) = messageState, !messages.isEmpty {
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
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background(.thinMaterial, in: Capsule())
                        .accessibilityAddTraits(.isHeader)

                    if messages.isEmpty, messageState == .loading || messageState == .idle {
                        ProgressView("Загружаем сообщения…")
                            .padding(.top, 48)
                            .accessibilityIdentifier("conversation-loading")
                    } else if messages.isEmpty, case let .failed(message) = messageState {
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
                    } else if messages.isEmpty {
                        ContentUnavailableView(
                            phoneString("conversation.no_messages"),
                            systemImage: "text.bubble",
                            description: Text(phoneString("conversation.no_messages_detail"))
                        )
                        .padding(.top, 48)
                    } else {
                        ForEach(messages) { message in
                            PhoneMessageBubble(
                                message: message,
                                retry: { store.retryMessage(message.id) },
                                react: { emoji in store.toggleReaction(emoji, messageID: message.id) }
                            )
                                .id(message.id)
                                .accessibilityIdentifier("message-\(message.id.uuidString.lowercased())")
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 8)
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
            .refreshable {
                await store.loadMessages(for: conversation.id, force: true)
                await store.markConversationRead(conversation.id)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MessageComposer(
                    store: store,
                    onAttachment: { presentedGate = mediaGate }
                )
            }
            .onChange(of: messages.count) { _, _ in
                guard let lastID = messages.last?.id else { return }
                withAnimation(.snappy(duration: store.reduceMotion ? 0 : 0.24)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
        }
        .task(id: conversation.id) {
            await store.loadMessages(for: conversation.id)
            await store.markConversationRead(conversation.id)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                PhoneConversationTitle(conversation: conversation)
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
    }
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
                .disabled(count == 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityIdentifier("message-send-failure")
    }
}

private struct PhoneConversationTitle: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 8) {
            AvatarView(participant: conversation.avatar, size: 32)
            VStack(alignment: .leading, spacing: 0) {
                Text(conversation.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(conversation.isTyping ? phoneString("chats.typing") : conversation.avatar.status)
                    .font(.caption2)
                    .foregroundStyle(conversation.isTyping ? LuxoraTheme.iris : .secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
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

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(LuxoraTheme.iris)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text(phoneString("conversation.pinned"))
                    .font(.caption.weight(.semibold))
                Text("Закреплённый контекст появится после серверной поддержки")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Image(systemName: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conversation-truth-state")
    }
}

private struct PhoneMessageBubble: View {
    let message: ChatMessage
    let retry: () -> Void
    let react: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.isOutgoing { Spacer(minLength: 54) }

            VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 6) {
                    if let replyPreview = message.replyPreview {
                        HStack(spacing: 7) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(message.isOutgoing ? .white.opacity(0.72) : LuxoraTheme.iris)
                                .frame(width: 3)
                            Text(replyPreview)
                                .font(.caption)
                                .lineLimit(2)
                        }
                        .foregroundStyle(message.isOutgoing ? .white.opacity(0.78) : .secondary)
                    }

                    Text(message.text)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 4) {
                        Spacer(minLength: 0)
                        if message.editedAt != nil { Text(phoneString("conversation.edited")) }
                        Text(message.sentAt, style: .time)
                        if message.isOutgoing {
                            Image(systemName: message.delivery.symbol)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(message.isOutgoing ? .white.opacity(0.72) : .secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .foregroundStyle(message.isOutgoing ? Color.white : Color.primary)
                .background {
                    if message.isOutgoing {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(LuxoraTheme.brandGradient)
                    } else {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color(uiColor: .secondarySystemGroupedBackground))
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
                            .disabled(message.delivery == .sending || message.delivery == .failed)
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
                    .accessibilityIdentifier("message-retry-\(message.id.uuidString.lowercased())")
                }
            }
            .frame(maxWidth: 310, alignment: message.isOutgoing ? .trailing : .leading)

            if !message.isOutgoing { Spacer(minLength: 54) }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if message.delivery != .sending, message.delivery != .failed {
                ForEach(["👍", "❤️", "🔥", "😂", "😮", "😢"], id: \.self) { emoji in
                    Button(emoji) { react(emoji) }
                }
            }
            if message.isOutgoing, message.delivery == .failed {
                Button("Повторить отправку", systemImage: "arrow.clockwise", action: retry)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.author.displayName): \(message.text)")
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

                if !localResults.isEmpty {
                    Section("Загруженные переписки") {
                        ForEach(localResults) { conversation in
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

                if !normalizedQuery.isEmpty {
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
                                retry: { Task { await store.searchKnownPeople(normalizedQuery) } }
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

                if normalizedQuery.isEmpty, localResults.isEmpty {
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
            .task(id: normalizedQuery) {
                guard !normalizedQuery.isEmpty else {
                    await store.searchKnownPeople("")
                    return
                }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await store.searchKnownPeople(normalizedQuery)
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
    let searchGate: FeatureGate
    let openConversation: (UUID) -> Void
    let close: () -> Void

    @State private var query = ""
    @State private var scope = "Чаты"
    @State private var hidesRecentPeople = false

    private var results: [Conversation] {
        store.conversations
            .filter {
                query.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(query)
                    || $0.subtitle.localizedCaseInsensitiveContains(query)
            }
            .filter { conversation in
                switch scope {
                case "Каналы": conversation.kind == .channel
                case "Люди": conversation.kind == .direct
                case "Медиа": false
                default: true
                }
            }
            .sorted { $0.lastActivity > $1.lastActivity }
    }

    private var recentPeople: [Conversation] {
        Array(store.conversations.filter { $0.kind == .direct }.prefix(5))
    }

    var body: some View {
        List {
            if !recentPeople.isEmpty, !hidesRecentPeople {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(recentPeople) { conversation in
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
                ForEach(results) { conversation in
                    Button { openConversation(conversation.id) } label: {
                        PhoneSearchResultRow(conversation: conversation)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(.init(top: 0, leading: 14, bottom: 0, trailing: 16))
                    .accessibilityIdentifier("search-result-\(conversation.id.uuidString.lowercased())")
                }
            } header: {
                HStack {
                    Text(query.isEmpty ? phoneString("search.recent") : phoneString("search.results"))
                    Spacer()
                    if query.isEmpty, !hidesRecentPeople {
                        Button(phoneString("search.clear_recent")) {
                            hidesRecentPeople = true
                        }
                        .font(.subheadline)
                        .textCase(nil)
                        .accessibilityIdentifier("search-clear-recent")
                    }
                }
            } footer: {
                Text(scope == "Медиа"
                     ? "\(searchGate.state.label): сервер пока не поддерживает поиск по медиа."
                     : "Сейчас поиск фильтрует только уже загруженные чаты Luxora.")
            }
        }
        .accessibilityIdentifier("search-screen")
        .overlay {
            if results.isEmpty {
                ContentUnavailableView(
                    "Ничего не найдено",
                    systemImage: scope == "Медиа" ? "lock.fill" : "magnifyingglass",
                    description: Text(scope == "Медиа" ? "Поиск по медиа пока недоступен." : "Измените запрос или область поиска.")
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
    }
}

private struct PhoneSearchBottomBar: View {
    @Binding var query: String
    @Binding var scope: String
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
    @Binding var selection: String

    private let scopes = ["Чаты", "Каналы", "Люди", "Медиа"]

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
                    .accessibilityIdentifier("search-scope-\(scope)")
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

private struct PhoneYouView: View {
    @Bindable var store: MessengerStore
    let featureMatrix: LuxoraFeatureMatrix
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
                    Text("@\(store.currentUser.username) · Beta-0.1")
                        .font(.callout)
                        .foregroundStyle(.secondary)
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
                    route: .folders,
                    symbol: "folder.fill",
                    color: .cyan,
                    title: phoneString("settings.folders"),
                    value: phoneString("common.local"),
                    identifier: "you-settings-folders",
                    locked: false
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
                }
                .accessibilityLabel("QR профиля")
                .accessibilityIdentifier("settings-profile-qr")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(phoneString("settings.edit")) { openRoute(.profile) }
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
            Text(title)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.86)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
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
    @Bindable var store: MessengerStore

    private var summaries: [PhoneFolderSummary] {
        PhoneFolderSummary.make(from: store.conversations)
    }

    var body: some View {
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
                    ForEach(Array(summaries.enumerated()), id: \.element.folder) { index, summary in
                        Button {
                            withAnimation(.snappy(duration: store.reduceMotion ? 0 : 0.22)) {
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
                        if index != summaries.indices.last {
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
                ForEach(Array(planned.enumerated()), id: \.offset) { _, item in
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

    @Environment(\.scenePhase) private var scenePhase
    @State private var permissions = PhoneSystemPermissionSnapshot.loading
    @State private var isRequesting = false

    var body: some View {
        List {
            Section("Доставка") {
                FeatureGateRow(gate: pushGate)
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
            Section("После подключения push-сервера") {
                PlannedRow(symbol: "message.badge.filled.fill", title: "Уведомления о сообщениях", detail: "Системные оповещения и предпросмотр на iPhone")
                PlannedRow(symbol: "speaker.wave.2.fill", title: "Звуки", detail: "Звуки отдельных чатов и общие звуки")
                PlannedRow(symbol: "moon.fill", title: "Тихие часы", detail: "Расписания и исключения пользователя")
                PlannedRow(symbol: "at", title: "Упоминания и ответы", detail: "Приоритет без манипуляций вовлечённостью")
            }
            Section {
                Text("Разрешение iPhone работает уже сейчас, но само по себе не означает доставку сообщений: серверный push для Beta-0.1 пока закрыт.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(phoneString("settings.notifications"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-notifications-screen")
        .task { await refreshPermissions() }
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
    }
}

private struct PhonePrivacySettingsView: View {
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
        .task { await refreshPermissions() }
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
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(status)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                HStack {
                    Text(gate.title)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 6)
                    Text(gate.state.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(stateColor)
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

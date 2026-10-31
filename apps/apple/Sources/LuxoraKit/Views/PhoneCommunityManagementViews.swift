#if os(iOS)
import SwiftUI
import UIKit

/// Manager-facing surface for a group or channel: invite links, the
/// join-request approval queue and the ownership-transfer ceremony.
///
/// Every action is gated by the real role from `CommunityStore` and by the
/// store's wired transport. The screen always renders loading, empty and
/// failure states instead of inventing server state.
struct PhoneCommunityManagementView: View {
    @Bindable var store: CommunityManagementStore
    @Bindable var communityStore: CommunityStore
    let conversation: Conversation
    var participantResolver: ((UUID) -> Participant?)?

    @State private var showsInviteCreator = false
    @State private var showsOwnershipPicker = false
    @State private var revokeCandidate: CommunityInviteLink?
    @State private var cancelTransferConfirmation = false
    @State private var acceptTransferConfirmation = false

    private var chatID: UUID { conversation.id }
    private var communityTitle: String { conversation.title }
    private var isManager: Bool { store.isManager(chatID: chatID) }
    private var isOwner: Bool { communityStore.currentUserRole(in: chatID) == .owner }
    private var isSuccessor: Bool { store.isSuccessor(chatID: chatID) }
    private var memberCount: Int {
        communityStore.community(chatID)?.memberCount ?? conversation.memberCount
    }
    private var currentRole: ChatMembershipRole? {
        communityStore.currentUserRole(in: chatID)
    }

    var body: some View {
        List {
            headerSection
            if isManager {
                inviteLinksSection
                joinRequestsSection
            }
            if isManager || isSuccessor {
                ownershipSection
            } else {
                accessGateSection
            }
            serverFactSection
        }
        .navigationTitle("Управление")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload(force: true) }
        .task(id: chatID) { await reload(force: false) }
        .onDisappear { store.clearCreatedInviteToken() }
        .sheet(isPresented: $showsInviteCreator) {
            PhoneCommunityInviteCreateSheet(store: store, chatID: chatID)
        }
        .sheet(isPresented: $showsOwnershipPicker) {
            PhoneOwnershipTransferSheet(
                store: store,
                communityStore: communityStore,
                conversation: conversation
            )
        }
        .confirmationDialog(
            Text("Отозвать ссылку-приглашение?"),
            isPresented: Binding(
                get: { revokeCandidate != nil },
                set: { if !$0 { revokeCandidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: revokeCandidate
        ) { link in
            Button("Отозвать", role: .destructive) {
                let linkID = link.id
                revokeCandidate = nil
                Task { _ = await store.revokeInviteLink(chatID: chatID, linkID: linkID) }
            }
            Button("Отмена", role: .cancel) { revokeCandidate = nil }
        } message: { _ in
            Text("Новые вступления по этой ссылке станут невозможны. Уже вступившие участники останутся.")
        }
        .confirmationDialog(
            "Отменить передачу владения?",
            isPresented: $cancelTransferConfirmation,
            titleVisibility: .visible
        ) {
            Button("Отменить передачу", role: .destructive) {
                Task {
                    if await store.cancelOwnershipTransfer(chatID: chatID) {
                        await refreshCommunity()
                    }
                }
            }
            Button("Нет", role: .cancel) {}
        } message: {
            Text("Передача перестанет действовать, роли не изменятся.")
        }
        .confirmationDialog(
            "Принять владение сообществом?",
            isPresented: $acceptTransferConfirmation,
            titleVisibility: .visible
        ) {
            Button("Принять владение") {
                Task {
                    if await store.acceptOwnershipTransfer(chatID: chatID) {
                        await refreshCommunity()
                    }
                }
            }
            Button("Позже", role: .cancel) {}
        } message: {
            Text("Вы станете владельцем, а текущий владелец — администратором. Изменение применяется только после подтверждения сервером.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("community-management-screen")
    }

    // MARK: Header

    private var headerSection: some View {
        Section {
            HStack(spacing: 12) {
                AvatarView(participant: conversation.avatar, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(communityTitle)
                        .font(.headline)
                        .lineLimit(2)
                    Text("\(memberCount) участников · ваша роль: \(roleTitle)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: Invite links

    private var inviteLinksSection: some View {
        Section {
            shownOnceInviteCard
            inviteLinksContent
            inviteCreateRow
            inviteActionErrorRow
        } header: {
            Text("Ссылки-приглашения")
        } footer: {
            Text("Токен новой ссылки показывается один раз: сервер хранит только его хеш. Скопируйте или отправьте токен сразу после создания.")
        }
    }

    @ViewBuilder
    private var shownOnceInviteCard: some View {
        if let creation = store.lastCreatedInvite, creation.invite.chatID == chatID {
            VStack(alignment: .leading, spacing: 10) {
                Label("Токен созданной ссылки — показывается один раз", systemImage: "key.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(LuxoraTheme.electricBlue)
                Text(creation.token)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityIdentifier("community-invite-token")
                Text("Скопируйте или отправьте его сейчас. Восстановить токен после закрытия невозможно.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = creation.token
                        store.markCreatedInviteCopied()
                    } label: {
                        Label(
                            store.lastCreatedInviteWasCopied ? "Скопировано" : "Копировать",
                            systemImage: store.lastCreatedInviteWasCopied ? "checkmark" : "doc.on.doc"
                        )
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("community-invite-copy")

                    ShareLink(item: inviteShareText(creation.token)) {
                        Label("Поделиться", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)

                    Spacer(minLength: 0)

                    Button("Скрыть") {
                        store.clearCreatedInviteToken()
                    }
                    .font(.footnote)
                    .accessibilityIdentifier("community-invite-dismiss-token")
                }
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("community-invite-shown-once")
        }
    }

    @ViewBuilder
    private var inviteLinksContent: some View {
        let links = store.inviteLinks(chatID: chatID)
        let state = store.inviteListState(chatID: chatID)
        if links.isEmpty {
            switch state {
            case .idle, .loading:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Загружаем ссылки…")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 56)
                .accessibilityIdentifier("community-invite-loading")
            case let .failed(detail):
                VStack(alignment: .leading, spacing: 8) {
                    Label("Не удалось загрузить ссылки", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await store.loadInviteLinks(chatID: chatID, force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("community-invite-failed")
            case .loaded:
                Text("Ссылок пока нет. Создайте первую, чтобы приглашать по токену.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("community-invite-empty")
            }
        } else {
            if case let .failed(detail) = state {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Не удалось обновить список")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await store.loadInviteLinks(chatID: chatID, force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("community-invite-refresh-failed")
            }
            ForEach(links, id: \.id) { link in
                PhoneCommunityInviteLinkRow(
                    link: link,
                    isRevoking: store.isRevokingInviteLink(link.id),
                    revoke: { revokeCandidate = link }
                )
            }
        }
    }

    @ViewBuilder
    private var inviteCreateRow: some View {
        if store.canCreateInviteLink(chatID: chatID) {
            Button {
                store.clearInviteActionError(chatID: chatID)
                showsInviteCreator = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundStyle(LuxoraTheme.electricBlue)
                    Text("Создать ссылку-приглашение")
                        .foregroundStyle(LuxoraTheme.electricBlue)
                    Spacer(minLength: 0)
                    if store.inviteActionState(chatID: chatID) == .loading {
                        ProgressView()
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(store.inviteActionState(chatID: chatID) == .loading)
            .accessibilityIdentifier("community-invite-create")
        } else if store.lastCreatedInvite?.invite.chatID == chatID {
            Text("Сначала сохраните показанный токен: вторая ссылка создаётся после закрытия карточки.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var inviteActionErrorRow: some View {
        if let error = store.inviteActionError(chatID: chatID) {
            VStack(alignment: .leading, spacing: 8) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                HStack(spacing: 10) {
                    if store.canRetryInviteCreation(chatID: chatID) {
                        Button("Повторить тот же запрос") {
                            Task { _ = await store.retryCreateInviteLink(chatID: chatID) }
                        }
                        .buttonStyle(.bordered)
                    }
                    Button("Скрыть") {
                        store.clearInviteActionError(chatID: chatID)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .accessibilityIdentifier("community-invite-action-error")
        }
    }

    // MARK: Join requests

    private var joinRequestsSection: some View {
        let requests = store.pendingJoinRequests(chatID: chatID)
        return Section {
            joinRequestsContent(requests: requests)
        } header: {
            Text(requests.isEmpty ? "Заявки на вступление" : "Заявки на вступление · \(requests.count)")
        } footer: {
            Text("Заявки появляются, когда ссылка создана с требованием одобрения. Решение отправляется на сервер и применяется только после его ответа.")
        }
    }

    @ViewBuilder
    private func joinRequestsContent(requests: [CommunityJoinRequest]) -> some View {
        let state = store.joinRequestListState(chatID: chatID)
        if requests.isEmpty {
            switch state {
            case .idle, .loading:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Загружаем заявки…")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 56)
                .accessibilityIdentifier("community-join-requests-loading")
            case let .failed(detail):
                VStack(alignment: .leading, spacing: 8) {
                    Label("Не удалось загрузить заявки", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await store.loadJoinRequests(chatID: chatID, force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("community-join-requests-failed")
            case .loaded:
                Text("Новых заявок нет.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("community-join-requests-empty")
            }
        } else {
            if case let .failed(detail) = state {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Не удалось обновить заявки")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await store.loadJoinRequests(chatID: chatID, force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("community-join-requests-refresh-failed")
            }
            ForEach(requests, id: \.id) { request in
                PhoneCommunityJoinRequestRow(
                    store: store,
                    chatID: chatID,
                    request: request,
                    participant: resolvedParticipant(request.userID),
                    onApproved: { await refreshCommunity() }
                )
            }
        }
    }

    // MARK: Ownership transfer

    private var ownershipSection: some View {
        Section {
            ownershipContent
        } header: {
            Text("Передача владения")
        } footer: {
            Text("Ожидающая передача действует 24 часа с момента создания. После принятия преемник становится владельцем, а текущий владелец — администратором.")
        }
    }

    @ViewBuilder
    private var ownershipContent: some View {
        switch store.ownershipTransferState(chatID: chatID) {
        case .idle, .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Проверяем передачу владения…")
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 56)
            .accessibilityIdentifier("community-ownership-loading")
        case let .failed(detail):
            VStack(alignment: .leading, spacing: 8) {
                Label("Не удалось загрузить состояние передачи", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.red)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Повторить") {
                    Task { await store.loadPendingOwnershipTransfer(chatID: chatID, force: true) }
                }
                .buttonStyle(.bordered)
            }
            .accessibilityIdentifier("community-ownership-failed")
        case .loaded:
            if let transfer = store.pendingTransfer(chatID: chatID) {
                ownershipPendingCard(transfer)
            } else if isOwner {
                ownershipOwnerIdleContent
            } else {
                Text("Ожидающих передач владения нет.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("community-ownership-empty")
            }
        }
    }

    private var ownershipOwnerIdleContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Передайте сообщество участнику: он получит 24 часа, чтобы принять владение. До принятия роли не меняются.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button {
                store.clearOwnershipActionError(chatID: chatID)
                showsOwnershipPicker = true
            } label: {
                Label("Передать владение…", systemImage: "arrow.left.arrow.right.circle")
            }
            .buttonStyle(.bordered)
            .disabled(store.ownershipActionState(chatID: chatID) == .loading)
            .accessibilityIdentifier("community-ownership-initiate")
            ownershipActionErrorContent
        }
    }

    @ViewBuilder
    private func ownershipPendingCard(_ transfer: CommunityOwnershipTransfer) -> some View {
        let expired = store.isPendingTransferExpired(chatID: chatID)
        VStack(alignment: .leading, spacing: 8) {
            Label(
                expired ? "Срок передачи истёк" : "Ожидает принятия",
                systemImage: expired ? "clock.badge.exclamationmark" : "arrow.left.arrow.right.circle.fill"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(expired ? .orange : LuxoraTheme.electricBlue)

            Text("\(resolvedDisplayName(transfer.fromUserID)) → \(resolvedDisplayName(transfer.toUserID))")
                .font(.body)
            Text("Создана \(transfer.createdAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Истекает \(transfer.expiresAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)

            if expired {
                Text("Сервер считает эту передачу истёкшей. Обновите состояние, чтобы увидеть актуальное.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if isSuccessor && !expired {
                Button {
                    acceptTransferConfirmation = true
                } label: {
                    Label("Принять владение", systemImage: "checkmark.seal.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.ownershipActionState(chatID: chatID) == .loading)
                .accessibilityIdentifier("community-ownership-accept")
                Text("Отклонить передачу может текущий владелец: попросите его отменить её.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if isOwner, transfer.fromUserID == communityStore.currentUserID, !expired {
                Button(role: .destructive) {
                    cancelTransferConfirmation = true
                } label: {
                    Label("Отменить передачу", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .disabled(store.ownershipActionState(chatID: chatID) == .loading)
                .accessibilityIdentifier("community-ownership-cancel")
            } else if isOwner, transfer.fromUserID == communityStore.currentUserID, expired {
                Button("Обновить состояние") {
                    Task { await store.loadPendingOwnershipTransfer(chatID: chatID, force: true) }
                }
                .buttonStyle(.bordered)
            } else {
                Text("Принять передачу может только назначенный преемник, а отменить — текущий владелец.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if store.ownershipActionState(chatID: chatID) == .loading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Отправляем на сервер…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ownershipActionErrorContent
        }
        .accessibilityIdentifier("community-ownership-pending")
    }

    @ViewBuilder
    private var ownershipActionErrorContent: some View {
        if let error = store.ownershipActionError(chatID: chatID) {
            VStack(alignment: .leading, spacing: 8) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                HStack(spacing: 10) {
                    if store.canRetryOwnershipInitiation(chatID: chatID) {
                        Button("Повторить тот же запрос") {
                            Task { _ = await store.retryInitiateOwnershipTransfer(chatID: chatID) }
                        }
                        .buttonStyle(.bordered)
                    }
                    Button("Обновить") {
                        Task {
                            store.clearOwnershipActionError(chatID: chatID)
                            await store.loadPendingOwnershipTransfer(chatID: chatID, force: true)
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
            .accessibilityIdentifier("community-ownership-action-error")
        }
    }

    private var accessGateSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Управление доступно не всем ролям", systemImage: "lock.fill")
                    .font(.subheadline.weight(.semibold))
                Text("Ссылки-приглашения и заявки на вступление видят владелец и администраторы. Если владелец передаёт вам сообщество, карточка принятия появится в этом разделе.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Проверить передачу владения") {
                    Task { await store.loadPendingOwnershipTransfer(chatID: chatID, force: true) }
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("community-ownership-check")
            }
            .accessibilityIdentifier("community-management-gate")
        }
    }

    private var serverFactSection: some View {
        Section {
            Label(
                "Действия выполняются на сервере Luxora: отклонённый запрос не меняет состояние.",
                systemImage: "checkmark.shield.fill"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: Actions and lookups

    private func reload(force: Bool) async {
        if isManager {
            await communityStore.loadMembers(chatID, force: force)
            await store.loadInviteLinks(chatID: chatID, force: force)
            await store.loadJoinRequests(chatID: chatID, force: force)
        }
        await store.loadPendingOwnershipTransfer(chatID: chatID, force: force)
    }

    private func refreshCommunity() async {
        await communityStore.refreshCommunity(chatID)
        await communityStore.loadMembers(chatID, force: true)
        await store.loadPendingOwnershipTransfer(chatID: chatID, force: true)
    }

    private func inviteShareText(_ token: String) -> String {
        """
        Приглашение в «\(communityTitle)» в Luxora.
        Токен: \(token)
        Откройте Luxora → «Группы и каналы» → «Присоединиться по ссылке» и вставьте токен.
        """
    }

    private func resolvedDisplayName(_ userID: UUID) -> String {
        if userID == communityStore.currentUserID { return "Вы" }
        if let member = communityStore.members(chatID).first(where: { $0.id == userID }) {
            return member.participant.displayName
        }
        if let participant = participantResolver?(userID) {
            return participant.displayName
        }
        return "Пользователь \(userID.uuidString.prefix(8))"
    }

    private func resolvedParticipant(_ userID: UUID) -> Participant? {
        if let member = communityStore.members(chatID).first(where: { $0.id == userID }) {
            return member.participant
        }
        return participantResolver?(userID)
    }

    private var roleTitle: String {
        switch currentRole {
        case .owner: "владелец"
        case .admin: "администратор"
        case .member: conversation.kind == .channel ? "подписчик" : "участник"
        case nil: "роль уточняется"
        }
    }
}

// MARK: - Invite link row

private struct PhoneCommunityInviteLinkRow: View {
    let link: CommunityInviteLink
    let isRevoking: Bool
    let revoke: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "link")
                .font(.title3)
                .foregroundStyle(link.isRevoked ? Color.secondary : LuxoraTheme.electricBlue)
                .frame(width: 28, alignment: .center)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(statusTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(statusColor)
                    if link.approvalRequired {
                        Text("По одобрению")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.orange.opacity(0.16), in: Capsule())
                            .foregroundStyle(.orange)
                    }
                }
                Text(usesTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(expiryTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            if isRevoking {
                ProgressView()
            } else if !link.isRevoked {
                Menu {
                    Button("Отозвать", systemImage: "xmark.circle", role: .destructive, action: revoke)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityIdentifier("community-invite-menu-\(link.id.uuidString)")
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("community-invite-row-\(link.id.uuidString)")
    }

    private var statusTitle: String {
        if link.isRevoked { return "Отозвана" }
        if link.isExpired() { return "Истекла" }
        if link.isExhausted { return "Исчерпана" }
        return "Действует"
    }

    private var statusColor: Color {
        if link.isRevoked || link.isExpired() || link.isExhausted { return .secondary }
        return .green
    }

    private var usesTitle: String {
        if let maxUses = link.maxUses {
            return "Использований: \(link.useCount) из \(maxUses)"
        }
        return "Использований: \(link.useCount) · без лимита"
    }

    private var expiryTitle: String {
        guard let expiresAt = link.expiresAt else { return "Срок: бессрочно" }
        if let revokedAt = link.revokedAt {
            return "Отозвана \(revokedAt.formatted(date: .abbreviated, time: .shortened))"
        }
        if link.isExpired() {
            return "Истекла \(expiresAt.formatted(date: .abbreviated, time: .shortened))"
        }
        return "Действует до \(expiresAt.formatted(date: .abbreviated, time: .shortened))"
    }
}

// MARK: - Join request row

private struct PhoneCommunityJoinRequestRow: View {
    @Bindable var store: CommunityManagementStore
    let chatID: UUID
    let request: CommunityJoinRequest
    let participant: Participant?
    let onApproved: () async -> Void

    private var decisionState: RemoteContentState {
        store.joinDecisionState(requestID: request.id)
    }

    private var errorMessage: String? {
        store.joinDecisionError(requestID: request.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                if let participant {
                    AvatarView(participant: participant, size: 44)
                } else {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .background(Color.secondary.opacity(0.12), in: Circle())
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.body.weight(.medium))
                    Text(secondaryLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if decisionState == .loading {
                    ProgressView()
                }
            }

            if decisionState != .loading {
                if store.isManager(chatID: chatID) {
                    HStack(spacing: 10) {
                        Button("Одобрить") {
                            Task {
                                if await store.approveJoinRequest(chatID: chatID, requestID: request.id) {
                                    await onApproved()
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .accessibilityIdentifier("community-join-approve-\(request.id.uuidString)")

                        Button("Отклонить", role: .destructive) {
                            Task {
                                _ = await store.denyJoinRequest(chatID: chatID, requestID: request.id)
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("community-join-deny-\(request.id.uuidString)")
                    }
                } else {
                    Text("Решать заявки могут владелец и администраторы.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let errorMessage {
                VStack(alignment: .leading, spacing: 6) {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    HStack(spacing: 8) {
                        if store.canRetryJoinDecision(requestID: request.id) {
                            Button("Повторить") {
                                Task {
                                    if await store.retryJoinDecision(chatID: chatID, requestID: request.id) {
                                        await onApproved()
                                    }
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        Button("Обновить") {
                            Task { await store.loadJoinRequests(chatID: chatID, force: true) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
                .accessibilityIdentifier("community-join-decision-error")
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("community-join-request-\(request.id.uuidString)")
    }

    private var displayName: String {
        participant?.displayName ?? "Пользователь"
    }

    private var secondaryLine: String {
        let created = request.createdAt.formatted(date: .abbreviated, time: .shortened)
        if let participant {
            return "@\(participant.username) · заявка от \(created)"
        }
        return "Профиль недоступен · ID \(request.userID.uuidString.prefix(8)) · заявка от \(created)"
    }
}

// MARK: - Invite creation sheet

private struct PhoneCommunityInviteCreateSheet: View {
    @Bindable var store: CommunityManagementStore
    let chatID: UUID

    @Environment(\.dismiss) private var dismiss
    @State private var approvalRequired = false
    @State private var expiry: InviteExpiryOption = .sevenDays
    @State private var limitedUses = false
    @State private var maxUses = 10

    private var isWorking: Bool {
        store.inviteActionState(chatID: chatID) == .loading
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Требовать одобрение заявки", isOn: $approvalRequired)
                        .accessibilityIdentifier("community-invite-create-approval")
                } footer: {
                    Text("С такой ссылкой человек отправляет заявку, а владелец или администратор одобряет её.")
                }

                Section("Срок действия") {
                    Picker("Срок действия", selection: $expiry) {
                        ForEach(InviteExpiryOption.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("community-invite-create-expiry")
                }

                Section {
                    Toggle("Ограничить число вступлений", isOn: $limitedUses)
                        .accessibilityIdentifier("community-invite-create-limit-toggle")
                    if limitedUses {
                        Stepper(value: $maxUses, in: 1...10_000) {
                            Text("Не более \(maxUses) вступлений")
                        }
                        .accessibilityIdentifier("community-invite-create-max-uses")
                    }
                } footer: {
                    Text("Лимит от 1 до 10 000. Без ограничения ссылка действует до истечения срока.")
                }

                if let error = store.inviteActionError(chatID: chatID) {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        if store.canRetryInviteCreation(chatID: chatID) {
                            Button("Повторить тот же запрос") {
                                Task { _ = await store.retryCreateInviteLink(chatID: chatID) }
                            }
                        }
                    }
                }

                Section {
                    Text("Токен показывается один раз сразу после создания. Сервер хранит только его хеш, поэтому потерянный токен нельзя показать повторно.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Новая ссылка-приглашение")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Создать") { submit() }
                        .fontWeight(.semibold)
                        .disabled(isWorking)
                        .accessibilityIdentifier("community-invite-create-submit")
                }
            }
            .overlay {
                if isWorking {
                    ZStack {
                        Color.black.opacity(0.12).ignoresSafeArea()
                        ProgressView("Создаём на сервере…")
                            .padding(20)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .accessibilityIdentifier("community-invite-create-loading")
                }
            }
        }
    }

    private func submit() {
        Task {
            let created = await store.createInviteLink(
                chatID: chatID,
                approvalRequired: approvalRequired,
                expiresInSeconds: expiry.seconds,
                maxUses: limitedUses ? maxUses : nil
            )
            guard created else { return }
            await store.loadInviteLinks(chatID: chatID, force: true)
            dismiss()
        }
    }
}

private enum InviteExpiryOption: String, CaseIterable, Identifiable {
    case oneHour
    case oneDay
    case sevenDays
    case thirtyDays
    case ninetyDays
    case unlimited

    var id: String { rawValue }

    var title: String {
        switch self {
        case .oneHour: "1 час"
        case .oneDay: "24 часа"
        case .sevenDays: "7 дней"
        case .thirtyDays: "30 дней"
        case .ninetyDays: "90 дней"
        case .unlimited: "Бессрочно"
        }
    }

    var seconds: Int? {
        switch self {
        case .oneHour: 3_600
        case .oneDay: 24 * 3_600
        case .sevenDays: 7 * 24 * 3_600
        case .thirtyDays: 30 * 24 * 3_600
        case .ninetyDays: 90 * 24 * 3_600
        case .unlimited: nil
        }
    }
}

// MARK: - Ownership transfer sheet

private struct PhoneOwnershipTransferSheet: View {
    @Bindable var store: CommunityManagementStore
    @Bindable var communityStore: CommunityStore
    let conversation: Conversation

    @Environment(\.dismiss) private var dismiss
    @State private var selectedMember: CommunityMember?
    @State private var showsConfirmation = false

    private var chatID: UUID { conversation.id }

    private var candidates: [CommunityMember] {
        communityStore.members(chatID).filter { member in
            member.id != communityStore.currentUserID && member.membership.role != .owner
        }
    }

    private var isWorking: Bool {
        store.ownershipActionState(chatID: chatID) == .loading
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("После подтверждения выбранный участник получит 24 часа, чтобы принять владение. Вы станете администратором только после принятия. Пока передача ожидает, роли не меняются.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Кому передать") {
                    if candidates.isEmpty {
                        if communityStore.memberListState(chatID) == .loading {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Загружаем участников…")
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Нет подтверждённого списка участников. Откройте профиль сообщества и обновите список.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ForEach(candidates) { member in
                            Button {
                                selectedMember = member
                            } label: {
                                HStack(spacing: 12) {
                                    AvatarView(participant: member.participant, size: 44)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(member.participant.displayName)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Text("@\(member.participant.username) · \(member.membership.role.russianTitle.lowercased())")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 6)
                                    if selectedMember?.id == member.id {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(LuxoraTheme.electricBlue)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("community-ownership-candidate-\(member.id.uuidString)")
                        }
                    }
                }

                if let error = store.ownershipActionError(chatID: chatID) {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        if store.canRetryOwnershipInitiation(chatID: chatID) {
                            Button("Повторить тот же запрос") {
                                Task { _ = await store.retryInitiateOwnershipTransfer(chatID: chatID) }
                            }
                        }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        showsConfirmation = true
                    } label: {
                        HStack {
                            Spacer()
                            Text("Передать владение")
                            Spacer()
                        }
                    }
                    .disabled(selectedMember == nil || isWorking)
                    .accessibilityIdentifier("community-ownership-confirm")
                }
            }
            .navigationTitle("Передать владение")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isWorking)
                }
            }
            .confirmationDialog(
                "Передать владение?",
                isPresented: $showsConfirmation,
                titleVisibility: .visible
            ) {
                Button("Передать владение", role: .destructive) {
                    initiate()
                }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("\(selectedMember?.participant.displayName ?? "Выбранный участник") станет владельцем, а вы — администратором после принятия. Если передачу не примут за 24 часа, она истечёт.")
            }
            .overlay {
                if isWorking {
                    ZStack {
                        Color.black.opacity(0.12).ignoresSafeArea()
                        ProgressView("Отправляем на сервер…")
                            .padding(20)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .accessibilityIdentifier("community-ownership-loading-overlay")
                }
            }
        }
    }

    private func initiate() {
        guard let selectedMember else { return }
        Task {
            if await store.initiateOwnershipTransfer(chatID: chatID, targetUserID: selectedMember.id) {
                dismiss()
            }
        }
    }
}

// MARK: - Join by link sheet

struct PhoneCommunityJoinByLinkSheet: View {
    @Bindable var store: CommunityManagementStore
    let refreshCommunities: () async -> Void
    let openConversation: (UUID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @FocusState private var inputFocused: Bool

    private var isWorking: Bool { store.joinByLinkState == .loading }
    private var normalizedInput: String {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canSubmit: Bool { !normalizedInput.isEmpty && !isWorking }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "Токен или ссылка-приглашение",
                        text: $input,
                        axis: .vertical
                    )
                    .lineLimit(2...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($inputFocused)
                    .submitLabel(.join)
                    .onSubmit { submit() }
                    .accessibilityIdentifier("communities-join-input")
                } header: {
                    Text("Приглашение")
                } footer: {
                    Text("Вставьте 43-символьный токен или ссылку, которая его содержит. Если ссылка требует одобрения, будет создана заявка на вступление.")
                }

                if let outcome = store.joinByLinkOutcome {
                    resultSection(outcome)
                }

                if case let .failed(detail) = store.joinByLinkState {
                    Section {
                        Label(detail, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        if store.canRetryJoinByInvite() {
                            Button("Повторить") {
                                Task { await retry() }
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("communities-join-retry")
                        }
                    }
                    .accessibilityIdentifier("communities-join-failed")
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking {
                                ProgressView()
                                    .padding(.trailing, 6)
                            }
                            Text(isWorking ? "Присоединяемся…" : "Присоединиться")
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("communities-join-submit")
                }
            }
            .navigationTitle("Присоединиться")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                        .disabled(isWorking)
                }
            }
            .onAppear {
                store.clearJoinByLinkResult()
                inputFocused = true
            }
            .interactiveDismissDisabled(isWorking)
        }
    }

    @ViewBuilder
    private func resultSection(_ outcome: CommunityInviteJoinOutcome) -> some View {
        Section {
            switch outcome {
            case let .joined(membership, replayed):
                Label("Вы вступили в сообщество", systemImage: "checkmark.seal.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.green)
                Text(replayed ? "Сервер подтвердил вступление (повторный запрос)." : "Сервер подтвердил вступление.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Открыть чат") {
                    Task {
                        await refreshCommunities()
                        openConversation(membership.chatID)
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("communities-join-open-chat")
            case let .pending(request, replayed):
                Label("Заявка отправлена", systemImage: "paperplane.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(LuxoraTheme.electricBlue)
                Text(replayed
                     ? "Заявка уже была отправлена ранее и ждёт решения владельца или администратора."
                     : "Владелец или администратор рассмотрит заявку. Присоединиться можно только после одобрения.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("ID заявки: \(request.id.uuidString.prefix(8))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("Понятно") { dismiss() }
                    .buttonStyle(.bordered)
            }
        } header: {
            Text("Результат")
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task {
            let outcome = await store.joinByInvite(rawInput: input)
            await openJoinedChatIfNeeded(outcome)
        }
    }

    private func retry() {
        Task {
            let outcome = await store.retryJoinByInvite()
            await openJoinedChatIfNeeded(outcome)
        }
    }

    private func openJoinedChatIfNeeded(_ outcome: CommunityInviteJoinOutcome?) async {
        guard case let .joined(membership, _) = outcome else { return }
        await refreshCommunities()
        openConversation(membership.chatID)
        dismiss()
    }
}
#endif

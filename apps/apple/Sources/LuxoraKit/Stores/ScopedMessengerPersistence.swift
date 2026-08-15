import Foundation

/// Account/session-scoped durable projection and text outbox.
///
/// This is deliberately a cache, not an authentication store: bearer and
/// refresh tokens are never accepted by its model. Message bodies are stored
/// as plaintext because Beta-0.1 does not yet provide E2EE or encrypted local
/// message storage. Production files receive iOS data protection, but a future
/// encrypted database migration remains required before claiming either.
actor ScopedMessengerPersistence {
    typealias AtomicWriter = @Sendable (Data, URL) throws -> Void
    typealias MessageSender = @Sendable (DurablePendingTextMessage) async throws
        -> DurableConfirmedMessageSnapshot

    private struct SchemaHeader: Decodable {
        let schemaVersion: Int
    }

    /// The only historical representation accepted for migration. V1 never
    /// persisted a realtime checkpoint or retry-attempt metadata.
    struct LegacyStateV1: Codable, Equatable, Sendable {
        struct Pending: Codable, Equatable, Sendable {
            let clientNonce: UUID
            let conversationID: UUID
            let body: String
            let replyToMessageID: UUID?
            let enqueuedAt: Date
            let ordinal: UInt64
        }

        let schemaVersion: Int
        let scope: DurableMessagingScope
        let conversations: [Conversation]
        let messages: [DurableConversationMessages]
        let pendingTextOutbox: [Pending]
        let nextOutboxOrdinal: UInt64
        let updatedAt: Date
    }

    private struct ScopedNonce: Hashable {
        let scope: DurableMessagingScope
        let nonce: UUID
    }

    private let rootDirectory: URL
    private let now: @Sendable () -> Date
    private let atomicWriter: AtomicWriter
    private var cachedStates: [DurableMessagingScope: DurableMessagingState] = [:]
    private var scopeEpochs: [DurableMessagingScope: UInt64] = [:]
    private var retiredScopes: Set<DurableMessagingScope> = []
    private var sendTasks: [ScopedNonce: Task<DurableConfirmedMessageSnapshot, Error>] = [:]
    private var activeReplays: Set<DurableMessagingScope> = []

    init(
        rootDirectory: URL = ScopedMessengerPersistence.defaultRootDirectory(),
        now: @escaping @Sendable () -> Date = Date.init,
        atomicWriter: @escaping AtomicWriter = { data, url in
            try data.write(to: url, options: .atomic)
        }
    ) {
        self.rootDirectory = rootDirectory
        self.now = now
        self.atomicWriter = atomicWriter
    }

    nonisolated static func defaultRootDirectory(fileManager: FileManager = .default) -> URL {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.temporaryDirectory
        return applicationSupport
            .appendingPathComponent("Luxora", isDirectory: true)
            .appendingPathComponent("DurableMessaging", isDirectory: true)
    }

    func load(scope: DurableMessagingScope) throws -> DurableMessagingLoadOutcome {
        if let state = cachedStates[scope] {
            return DurableMessagingLoadOutcome(state: state, recovery: .none)
        }

        let url = stateURL(for: scope)
        guard FileManager.default.fileExists(atPath: url.path) else {
            let state = DurableMessagingState.empty(scope: scope, now: now())
            cachedStates[scope] = state
            return DurableMessagingLoadOutcome(state: state, recovery: .none)
        }

        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw error
        }

        do {
            let decoder = Self.makeDecoder()
            let header = try decoder.decode(SchemaHeader.self, from: data)
            switch header.schemaVersion {
            case DurableMessagingState.currentSchemaVersion:
                let state = try decoder.decode(DurableMessagingState.self, from: data)
                try validate(state, expectedScope: scope)
                cachedStates[scope] = state
                return DurableMessagingLoadOutcome(state: state, recovery: .none)
            case 1:
                let legacy = try decoder.decode(LegacyStateV1.self, from: data)
                let migrated = try migrate(legacy, expectedScope: scope)
                try persist(migrated)
                cachedStates[scope] = migrated
                return DurableMessagingLoadOutcome(
                    state: migrated,
                    recovery: .migrated(fromSchemaVersion: 1)
                )
            default:
                throw DurableMessagingError.unsupportedSchema(header.schemaVersion)
            }
        } catch {
            let quarantinedURL = try quarantineCorruptFile(url)
            let clean = DurableMessagingState.empty(scope: scope, now: now())
            cachedStates[scope] = clean
            return DurableMessagingLoadOutcome(
                state: clean,
                recovery: .discardedCorruptFile(quarantinedURL)
            )
        }
    }

    func state(scope: DurableMessagingScope) throws -> DurableMessagingState {
        try load(scope: scope).state
    }

    func replaceConfirmedProjection(
        scope: DurableMessagingScope,
        conversations: [Conversation],
        messages: [DurableConversationMessages]
    ) throws {
        var state = try mutableState(scope: scope)
        Self.replaceConfirmedProjection(
            in: &state,
            conversations: conversations,
            messages: messages
        )
        try commit(&state)
    }

    /// Projection and cursor form one durable boundary. They must share the
    /// same atomic file replacement so a disk failure can advance neither half.
    func replaceConfirmedProjectionAndCheckpoint(
        scope: DurableMessagingScope,
        conversations: [Conversation],
        messages: [DurableConversationMessages],
        checkpoint: DurableRealtimeCheckpoint
    ) throws {
        var state = try mutableState(scope: scope)
        Self.replaceConfirmedProjection(
            in: &state,
            conversations: conversations,
            messages: messages
        )
        try validate(checkpoint, current: state.realtimeV2Checkpoint)
        state.realtimeV2Checkpoint = checkpoint
        try commit(&state)
    }

    func replaceConfirmedConversations(
        scope: DurableMessagingScope,
        conversations: [Conversation]
    ) throws {
        var state = try mutableState(scope: scope)
        state.conversations = conversations
        let conversationIDs = Set(conversations.map(\.id))
        state.messages.removeAll { !conversationIDs.contains($0.conversationID) }
        // Keep pending entries even if the current server page does not include
        // their chat; only an explicit server rejection may settle an outbox row.
        try commit(&state)
    }

    func replaceConfirmedMessages(
        scope: DurableMessagingScope,
        conversationID: UUID,
        snapshots: [DurableConfirmedMessageSnapshot]
    ) throws {
        var state = try mutableState(scope: scope)
        guard state.conversations.contains(where: { $0.id == conversationID }) else {
            throw DurableMessagingError.invalidState
        }
        state.messages.removeAll { $0.conversationID == conversationID }
        state.messages.append(
            DurableConversationMessages(
                conversationID: conversationID,
                snapshots: Self.canonicalSnapshots(snapshots)
            )
        )
        let confirmedNonces = Set(snapshots.map(\.message.clientID))
        state.pendingTextOutbox.removeAll { confirmedNonces.contains($0.clientNonce) }
        try commit(&state)
    }

    @discardableResult
    func enqueueText(
        scope: DurableMessagingScope,
        conversationID: UUID,
        clientNonce: UUID,
        body: String,
        replyToMessageID: UUID?,
        enqueuedAt: Date? = nil
    ) throws -> DurablePendingTextMessage {
        var state = try mutableState(scope: scope)
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedBody.isEmpty, normalizedBody.count <= 10_000 else {
            throw DurableMessagingError.invalidPendingMessage
        }

        if let existing = state.pendingTextOutbox.first(where: { $0.clientNonce == clientNonce }) {
            guard existing.conversationID == conversationID,
                  existing.body == normalizedBody,
                  existing.replyToMessageID == replyToMessageID
            else { throw DurableMessagingError.nonceCollision }
            return existing
        }
        if state.messages.flatMap(\.snapshots).contains(where: {
            $0.message.clientID == clientNonce
        }) {
            throw DurableMessagingError.nonceCollision
        }
        guard state.nextOutboxOrdinal < UInt64.max else {
            throw DurableMessagingError.invalidState
        }

        let pending = DurablePendingTextMessage(
            clientNonce: clientNonce,
            conversationID: conversationID,
            body: normalizedBody,
            replyToMessageID: replyToMessageID,
            enqueuedAt: enqueuedAt ?? now(),
            ordinal: state.nextOutboxOrdinal,
            attemptCount: 0,
            lastAttemptAt: nil
        )
        state.nextOutboxOrdinal += 1
        state.pendingTextOutbox.append(pending)
        try commit(&state)
        return pending
    }

    /// Persists the outbox row before network I/O, uses exactly one in-flight
    /// request per scoped nonce, and removes the row in the same atomic write
    /// that accepts the confirmed server snapshot.
    func sendText(
        scope: DurableMessagingScope,
        conversationID: UUID,
        clientNonce: UUID,
        body: String,
        replyToMessageID: UUID?,
        enqueuedAt: Date? = nil,
        sender: @escaping MessageSender
    ) async throws -> DurableConfirmedMessageSnapshot {
        let pending = try enqueueText(
            scope: scope,
            conversationID: conversationID,
            clientNonce: clientNonce,
            body: body,
            replyToMessageID: replyToMessageID,
            enqueuedAt: enqueuedAt
        )
        return try await sendExisting(scope: scope, pending: pending, sender: sender)
    }

    func replayPending(
        scope: DurableMessagingScope,
        sender: @escaping MessageSender
    ) async -> DurableOutboxReplayResult {
        let initial: DurableMessagingState
        do {
            initial = try state(scope: scope)
        } catch {
            return DurableOutboxReplayResult(
                confirmed: [],
                remainingCount: 0,
                stoppedAtNonce: nil,
                errorDescription: error.localizedDescription,
                alreadyRunning: false
            )
        }
        guard activeReplays.insert(scope).inserted else {
            return .running(remainingCount: initial.pendingTextOutbox.count)
        }
        defer { activeReplays.remove(scope) }

        var confirmed: [DurableConfirmedMessageSnapshot] = []
        while true {
            let next: DurablePendingTextMessage?
            do {
                next = try state(scope: scope).pendingTextOutbox
                    .sorted { $0.ordinal < $1.ordinal }
                    .first
            } catch {
                return DurableOutboxReplayResult(
                    confirmed: confirmed,
                    remainingCount: 0,
                    stoppedAtNonce: nil,
                    errorDescription: error.localizedDescription,
                    alreadyRunning: false
                )
            }
            guard let next else {
                return DurableOutboxReplayResult(
                    confirmed: confirmed,
                    remainingCount: 0,
                    stoppedAtNonce: nil,
                    errorDescription: nil,
                    alreadyRunning: false
                )
            }

            do {
                confirmed.append(try await sendExisting(scope: scope, pending: next, sender: sender))
            } catch {
                let remaining = (try? state(scope: scope).pendingTextOutbox.count) ?? 0
                return DurableOutboxReplayResult(
                    confirmed: confirmed,
                    remainingCount: remaining,
                    stoppedAtNonce: next.clientNonce,
                    errorDescription: error.localizedDescription,
                    alreadyRunning: false
                )
            }
        }
    }

    /// Exact logout fence. A late response from an in-flight sender observes a
    /// changed epoch and cannot recreate the removed session directory.
    func remove(scope: DurableMessagingScope) throws {
        retire(scope: scope)
        try removeScopeNodeIfPresent(scope)
    }

    /// Removes one device session even when a fresh actor has not loaded its
    /// account-scoped file yet. The scan is deliberately one level deep under
    /// this app-owned root and never traverses account-directory symlinks.
    func removeSession(_ sessionID: UUID) throws {
        let knownScopes = Set(cachedStates.keys)
            .union(scopeEpochs.keys)
            .union(sendTasks.keys.map(\.scope))
            .filter { $0.sessionID == sessionID }
        var firstError: Error?
        for scope in knownScopes {
            do {
                try remove(scope: scope)
            } catch {
                firstError = firstError ?? error
            }
        }

        if let rootValues = try resourceValuesIfPresent(at: rootDirectory) {
            guard rootValues.isSymbolicLink != true, rootValues.isDirectory == true else {
                throw DurableMessagingError.invalidState
            }
            let accountDirectories = try FileManager.default.contentsOfDirectory(
                at: rootDirectory,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )
            for accountDirectory in accountDirectories {
                do {
                    let values = try accountDirectory.resourceValues(
                        forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
                    )
                    guard values.isDirectory == true,
                          values.isSymbolicLink != true,
                          let accountID = UUID(uuidString: accountDirectory.lastPathComponent),
                          accountDirectory.lastPathComponent == accountID.uuidString.lowercased()
                    else { continue }

                    let candidate = accountDirectory.appendingPathComponent(
                        sessionID.uuidString.lowercased(),
                        isDirectory: true
                    )
                    guard candidate.deletingLastPathComponent().standardizedFileURL
                        == accountDirectory.standardizedFileURL,
                          try resourceValuesIfPresent(at: candidate) != nil
                    else { continue }
                    // removeItem removes a symlink itself rather than following
                    // it, so this exact session node is safe for either shape.
                    try FileManager.default.removeItem(at: candidate)
                } catch {
                    firstError = firstError ?? error
                }
            }
        }
        if let firstError { throw firstError }
    }

    /// Last-resort privacy teardown for an undecodable single-active-session
    /// Keychain record. Only the configured app-owned durable root is removed.
    func removeAll() throws {
        let knownScopes = Set(cachedStates.keys)
            .union(scopeEpochs.keys)
            .union(sendTasks.keys.map(\.scope))
        for scope in knownScopes {
            retire(scope: scope)
        }
        cachedStates.removeAll()
        activeReplays.removeAll()

        let standardizedRoot = rootDirectory.standardizedFileURL
        guard standardizedRoot.path != "/",
              standardizedRoot.pathComponents.count > 2
        else { throw DurableMessagingError.invalidState }
        guard try resourceValuesIfPresent(at: rootDirectory) != nil else { return }
        // Foundation removes a symlink node without following it. For a normal
        // directory this recursively removes only the exact configured root.
        try FileManager.default.removeItem(at: rootDirectory)
    }

    private func retire(scope: DurableMessagingScope) {
        scopeEpochs[scope, default: 0] &+= 1
        retiredScopes.insert(scope)
        cachedStates[scope] = nil
        activeReplays.remove(scope)
        let keys = sendTasks.keys.filter { $0.scope == scope }
        for key in keys {
            sendTasks[key]?.cancel()
            sendTasks[key] = nil
        }
    }

    func removeAccount(_ accountID: UUID) throws {
        let scopes = Set(cachedStates.keys.filter { $0.accountID == accountID })
            .union(scopeEpochs.keys.filter { $0.accountID == accountID })
        for scope in scopes {
            try remove(scope: scope)
        }
        let accountDirectory = rootDirectory
            .appendingPathComponent(accountID.uuidString.lowercased(), isDirectory: true)
        if FileManager.default.fileExists(atPath: accountDirectory.path) {
            try FileManager.default.removeItem(at: accountDirectory)
        }
    }

    func fileURL(scope: DurableMessagingScope) -> URL {
        stateURL(for: scope)
    }

    private func sendExisting(
        scope: DurableMessagingScope,
        pending: DurablePendingTextMessage,
        sender: @escaping MessageSender
    ) async throws -> DurableConfirmedMessageSnapshot {
        let key = ScopedNonce(scope: scope, nonce: pending.clientNonce)
        if let existingTask = sendTasks[key] {
            let snapshot = try await existingTask.value
            try acceptConfirmation(scope: scope, pending: pending, snapshot: snapshot)
            return snapshot
        }

        var state = try mutableState(scope: scope)
        guard let index = state.pendingTextOutbox.firstIndex(where: {
            $0.clientNonce == pending.clientNonce
        }) else {
            if let alreadyConfirmed = state.messages.flatMap(\.snapshots).first(where: {
                $0.message.clientID == pending.clientNonce
            }) {
                return alreadyConfirmed
            }
            throw DurableMessagingError.scopeInvalidated
        }
        let epoch = scopeEpochs[scope, default: 0]
        state.pendingTextOutbox[index].attemptCount += 1
        state.pendingTextOutbox[index].lastAttemptAt = now()
        let attempted = state.pendingTextOutbox[index]
        try commit(&state)

        let task = Task { try await sender(attempted) }
        sendTasks[key] = task
        defer { sendTasks[key] = nil }
        do {
            let snapshot = try await task.value
            guard scopeEpochs[scope, default: 0] == epoch else {
                throw DurableMessagingError.scopeInvalidated
            }
            try acceptConfirmation(scope: scope, pending: attempted, snapshot: snapshot)
            return snapshot
        } catch {
            throw error
        }
    }

    private func acceptConfirmation(
        scope: DurableMessagingScope,
        pending: DurablePendingTextMessage,
        snapshot: DurableConfirmedMessageSnapshot
    ) throws {
        guard snapshot.message.clientID == pending.clientNonce,
              snapshot.message.conversationID == pending.conversationID,
              snapshot.message.text == pending.body,
              snapshot.message.isOutgoing,
              snapshot.metadata.replyToMessageID == pending.replyToMessageID,
              ![MessageDelivery.sending, .failed].contains(snapshot.message.delivery)
        else { throw DurableMessagingError.inconsistentConfirmation }

        var state = try mutableState(scope: scope)
        if let stored = state.pendingTextOutbox.first(where: {
            $0.clientNonce == pending.clientNonce
        }) {
            guard stored.conversationID == pending.conversationID,
                  stored.body == pending.body,
                  stored.replyToMessageID == pending.replyToMessageID
            else { throw DurableMessagingError.nonceCollision }
        } else if state.messages.flatMap(\.snapshots).contains(where: {
            $0.message.clientID == pending.clientNonce && $0.message.id == snapshot.message.id
        }) {
            return
        } else {
            throw DurableMessagingError.scopeInvalidated
        }

        state.pendingTextOutbox.removeAll { $0.clientNonce == pending.clientNonce }
        var bucket = state.messages.first(where: { $0.conversationID == pending.conversationID })
            ?? DurableConversationMessages(conversationID: pending.conversationID, snapshots: [])
        bucket.snapshots.removeAll {
            $0.message.id == snapshot.message.id || $0.message.clientID == pending.clientNonce
        }
        bucket.snapshots.append(snapshot)
        bucket.snapshots = Self.canonicalSnapshots(bucket.snapshots)
        state.messages.removeAll { $0.conversationID == pending.conversationID }
        state.messages.append(bucket)
        try commit(&state)
    }

    private func mutableState(scope: DurableMessagingScope) throws -> DurableMessagingState {
        try load(scope: scope).state
    }

    private func commit(_ state: inout DurableMessagingState) throws {
        guard !retiredScopes.contains(state.scope) else {
            throw DurableMessagingError.scopeInvalidated
        }
        state.schemaVersion = DurableMessagingState.currentSchemaVersion
        state.generation &+= 1
        state.updatedAt = now()
        try validate(state, expectedScope: state.scope)
        try persist(state)
        cachedStates[state.scope] = state
    }

    private func persist(_ state: DurableMessagingState) throws {
        let url = stateURL(for: state.scope)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try Self.makeEncoder().encode(state)
        try atomicWriter(data, url)
        #if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        #endif
    }

    private func validate(
        _ state: DurableMessagingState,
        expectedScope: DurableMessagingScope
    ) throws {
        guard state.schemaVersion == DurableMessagingState.currentSchemaVersion,
              state.scope == expectedScope,
              state.nextOutboxOrdinal > 0,
              Set(state.conversations.map(\.id)).count == state.conversations.count,
              Set(state.messages.map(\.conversationID)).count == state.messages.count
        else { throw DurableMessagingError.invalidState }

        let conversationIDs = Set(state.conversations.map(\.id))
        var messageIDs = Set<UUID>()
        var confirmedNonces = Set<UUID>()
        for bucket in state.messages {
            guard conversationIDs.contains(bucket.conversationID) else {
                throw DurableMessagingError.invalidState
            }
            for snapshot in bucket.snapshots {
                guard snapshot.message.conversationID == bucket.conversationID,
                      ![MessageDelivery.sending, .failed].contains(snapshot.message.delivery),
                      messageIDs.insert(snapshot.message.id).inserted,
                      confirmedNonces.insert(snapshot.message.clientID).inserted
                else { throw DurableMessagingError.invalidState }
            }
        }

        let pendingNonces = state.pendingTextOutbox.map(\.clientNonce)
        let ordinals = state.pendingTextOutbox.map(\.ordinal)
        guard Set(pendingNonces).count == pendingNonces.count,
              Set(ordinals).count == ordinals.count,
              Set(pendingNonces).isDisjoint(with: confirmedNonces),
              state.pendingTextOutbox.allSatisfy({ pending in
                  let normalized = pending.body.trimmingCharacters(in: .whitespacesAndNewlines)
                  return !normalized.isEmpty
                      && normalized == pending.body
                      && normalized.count <= 10_000
                      && pending.ordinal > 0
                      && pending.ordinal < state.nextOutboxOrdinal
                      && pending.attemptCount >= 0
              })
        else { throw DurableMessagingError.invalidState }

        if let checkpoint = state.realtimeV2Checkpoint {
            guard checkpoint.sequence >= 0,
                  RealtimeCursorValidator.isValid(checkpoint.cursor),
                  checkpoint.expiresAt > checkpoint.capturedAt
            else { throw DurableMessagingError.invalidState }
        }
    }

    private func validate(
        _ checkpoint: DurableRealtimeCheckpoint,
        current: DurableRealtimeCheckpoint?
    ) throws {
        guard checkpoint.sequence >= 0,
              RealtimeCursorValidator.isValid(checkpoint.cursor),
              checkpoint.expiresAt > checkpoint.capturedAt
        else { throw DurableMessagingError.invalidCheckpoint }
        if let current {
            guard checkpoint.sequence >= current.sequence else {
                throw DurableMessagingError.invalidCheckpoint
            }
            if checkpoint.sequence == current.sequence,
               checkpoint.cursor != current.cursor {
                throw DurableMessagingError.invalidCheckpoint
            }
        }
    }

    private func migrate(
        _ legacy: LegacyStateV1,
        expectedScope: DurableMessagingScope
    ) throws -> DurableMessagingState {
        guard legacy.schemaVersion == 1, legacy.scope == expectedScope else {
            throw DurableMessagingError.invalidState
        }
        let migrated = DurableMessagingState(
            schemaVersion: DurableMessagingState.currentSchemaVersion,
            scope: legacy.scope,
            generation: 0,
            conversations: legacy.conversations,
            messages: legacy.messages,
            pendingTextOutbox: legacy.pendingTextOutbox.map {
                DurablePendingTextMessage(
                    clientNonce: $0.clientNonce,
                    conversationID: $0.conversationID,
                    body: $0.body,
                    replyToMessageID: $0.replyToMessageID,
                    enqueuedAt: $0.enqueuedAt,
                    ordinal: $0.ordinal,
                    attemptCount: 0,
                    lastAttemptAt: nil
                )
            },
            realtimeV2Checkpoint: nil,
            nextOutboxOrdinal: legacy.nextOutboxOrdinal,
            updatedAt: now()
        )
        try validate(migrated, expectedScope: expectedScope)
        return migrated
    }

    private func quarantineCorruptFile(_ url: URL) throws -> URL {
        let quarantined = url.deletingPathExtension()
            .appendingPathExtension("corrupt-\(UUID().uuidString.lowercased()).json")
        try FileManager.default.moveItem(at: url, to: quarantined)
        return quarantined
    }

    private func resourceValuesIfPresent(at url: URL) throws -> URLResourceValues? {
        do {
            return try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        } catch {
            let cocoa = error as NSError
            if cocoa.domain == NSCocoaErrorDomain,
               cocoa.code == NSFileNoSuchFileError || cocoa.code == NSFileReadNoSuchFileError {
                return nil
            }
            throw error
        }
    }

    private func removeScopeNodeIfPresent(_ scope: DurableMessagingScope) throws {
        guard let rootValues = try resourceValuesIfPresent(at: rootDirectory) else { return }
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw DurableMessagingError.invalidState
        }
        let accountDirectory = rootDirectory.appendingPathComponent(
            scope.accountID.uuidString.lowercased(),
            isDirectory: true
        )
        guard let accountValues = try resourceValuesIfPresent(at: accountDirectory) else { return }
        guard accountValues.isDirectory == true, accountValues.isSymbolicLink != true else {
            throw DurableMessagingError.invalidState
        }
        let directory = scopeDirectory(for: scope)
        guard directory.deletingLastPathComponent().standardizedFileURL
            == accountDirectory.standardizedFileURL,
              try resourceValuesIfPresent(at: directory) != nil
        else { return }
        // If the final session node itself is a symlink, removeItem unlinks it
        // and never traverses into its target.
        try FileManager.default.removeItem(at: directory)
    }

    private func scopeDirectory(for scope: DurableMessagingScope) -> URL {
        rootDirectory
            .appendingPathComponent(scope.accountID.uuidString.lowercased(), isDirectory: true)
            .appendingPathComponent(scope.sessionID.uuidString.lowercased(), isDirectory: true)
    }

    private func stateURL(for scope: DurableMessagingScope) -> URL {
        scopeDirectory(for: scope).appendingPathComponent("state-v2.json")
    }

    private static func canonicalMessages(
        _ messages: [DurableConversationMessages]
    ) -> [DurableConversationMessages] {
        messages
            .map {
                DurableConversationMessages(
                    conversationID: $0.conversationID,
                    snapshots: canonicalSnapshots($0.snapshots)
                )
            }
            .sorted { $0.conversationID.uuidString < $1.conversationID.uuidString }
    }

    private static func replaceConfirmedProjection(
        in state: inout DurableMessagingState,
        conversations: [Conversation],
        messages: [DurableConversationMessages]
    ) {
        state.conversations = conversations
        state.messages = canonicalMessages(messages)
        let confirmedNonces = Set(state.messages.flatMap { bucket in
            bucket.snapshots.map(\.message.clientID)
        })
        state.pendingTextOutbox.removeAll { confirmedNonces.contains($0.clientNonce) }
    }

    private static func canonicalSnapshots(
        _ snapshots: [DurableConfirmedMessageSnapshot]
    ) -> [DurableConfirmedMessageSnapshot] {
        snapshots.sorted {
            if $0.message.sentAt != $1.message.sentAt {
                return $0.message.sentAt < $1.message.sentAt
            }
            return $0.message.id.uuidString < $1.message.id.uuidString
        }
    }

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class ProfileAvatarStoreTests: XCTestCase {
    func testFailedUploadKeepsOldProjectionAndExactRetryPublishesEveryOwnedAvatar() async {
        let original = participant(avatarPath: nil)
        let ownedConversation = conversation(avatar: original)
        let probe = ProfileAvatarMutationProbe(original: original, failsFirstUpload: true)
        let store = MessengerStore(
            conversations: [ownedConversation],
            messagesByConversation: [:],
            currentUser: original
        )
        configure(store, probe: probe)
        let png = Data([0x89, 0x50, 0x4E, 0x47])

        let firstAccepted = await store.updateCurrentUserAvatar(pngData: png)
        XCTAssertFalse(firstAccepted)
        XCTAssertNil(store.currentUser.avatarPath)
        guard case .failed = store.avatarUpdateState else {
            return XCTFail("Upload failure must expose a retry state")
        }

        let retryAccepted = await store.updateCurrentUserAvatar(pngData: png)
        XCTAssertTrue(retryAccepted)
        XCTAssertEqual(store.currentUser.avatarPath, ProfileAvatarMutationProbe.avatarPath)
        XCTAssertEqual(store.conversations.first?.avatar.avatarPath, ProfileAvatarMutationProbe.avatarPath)
        let uploadedPayloads = await probe.uploadedPayloads
        XCTAssertEqual(uploadedPayloads, [png, png])
        XCTAssertEqual(store.avatarUpdateState, .loaded)
    }

    func testClearPublishesServerReturnedFallbackProjection() async {
        let original = participant(avatarPath: ProfileAvatarMutationProbe.avatarPath)
        let probe = ProfileAvatarMutationProbe(original: original)
        let store = MessengerStore(
            conversations: [conversation(avatar: original)],
            messagesByConversation: [:],
            currentUser: original
        )
        configure(store, probe: probe)

        let accepted = await store.clearCurrentUserAvatar()
        XCTAssertTrue(accepted)

        XCTAssertNil(store.currentUser.avatarPath)
        XCTAssertNil(store.conversations.first?.avatar.avatarPath)
        let clearCount = await probe.clearCount
        XCTAssertEqual(clearCount, 1)
    }

    func testInvalidImageFailsLocallyWithoutCallingServer() async {
        let original = participant(avatarPath: nil)
        let probe = ProfileAvatarMutationProbe(original: original)
        let store = MessengerStore(
            conversations: [],
            messagesByConversation: [:],
            currentUser: original
        )
        configure(store, probe: probe)

        let accepted = await store.updateCurrentUserAvatar(pngData: Data())
        XCTAssertFalse(accepted)

        let uploadedPayloads = await probe.uploadedPayloads
        XCTAssertTrue(uploadedPayloads.isEmpty)
        guard case .failed = store.avatarUpdateState else {
            return XCTFail("Invalid local data must produce a visible failure")
        }
    }

    private func configure(_ store: MessengerStore, probe: ProfileAvatarMutationProbe) {
        store.configureRemote(
            sender: { _, _, _ in throw ProfileAvatarStoreTestError.unused },
            loader: { _ in [] },
            avatarUploader: { try await probe.upload($0) },
            avatarClearer: { await probe.clear() }
        )
    }

    private func participant(avatarPath: String?) -> Participant {
        Participant(
            id: UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!,
            displayName: "Flenym",
            username: "flenym",
            initials: "F",
            accentHex: "725CFF",
            isOnline: true,
            status: "Luxora",
            avatarPath: avatarPath
        )
    }

    private func conversation(avatar: Participant) -> Conversation {
        Conversation(
            id: UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!,
            title: "Избранное",
            subtitle: "",
            kind: .saved,
            avatar: avatar,
            memberCount: 1,
            unreadCount: 0,
            isMuted: false,
            isPinned: true,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(timeIntervalSince1970: 1_800_000_000),
            folder: "saved"
        )
    }
}

private actor ProfileAvatarMutationProbe {
    static let avatarPath = "/v1/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc/content"

    private let original: Participant
    private let failsFirstUpload: Bool
    private(set) var uploadedPayloads: [Data] = []
    private(set) var clearCount = 0

    init(original: Participant, failsFirstUpload: Bool = false) {
        self.original = original
        self.failsFirstUpload = failsFirstUpload
    }

    func upload(_ data: Data) throws -> CurrentUserProfileSnapshot {
        uploadedPayloads.append(data)
        if failsFirstUpload, uploadedPayloads.count == 1 {
            throw ProfileAvatarStoreTestError.responseLost
        }
        var updated = original
        updated.avatarPath = Self.avatarPath
        return CurrentUserProfileSnapshot(participant: updated, bio: "Luxora")
    }

    func clear() -> CurrentUserProfileSnapshot {
        clearCount += 1
        var updated = original
        updated.avatarPath = nil
        return CurrentUserProfileSnapshot(participant: updated, bio: "Luxora")
    }
}

private enum ProfileAvatarStoreTestError: LocalizedError {
    case responseLost
    case unused

    var errorDescription: String? {
        switch self {
        case .responseLost: "Ответ сервера потерян"
        case .unused: "Не используется"
        }
    }
}

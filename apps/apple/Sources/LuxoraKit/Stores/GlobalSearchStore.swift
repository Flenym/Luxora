import Foundation
import Observation

private enum GlobalSearchStoreError: LocalizedError {
    case unavailable
    case invalidCursor
    case pageLimit

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Серверный поиск недоступен на этом подключении."
        case .invalidCursor:
            "Сервер повторил страницу поиска. Обновите запрос и попробуйте снова."
        case .pageLimit:
            "Поиск вернул слишком много страниц. Уточните запрос."
        }
    }
}

@MainActor
@Observable
public final class GlobalSearchStore {
    static let maximumPages = 100

    public private(set) var people: [Participant] = []
    public private(set) var messages: [GlobalMessageSearchResult] = []
    public private(set) var files: [GlobalFileSearchResult] = []
    public private(set) var state: RemoteContentState = .idle
    public private(set) var activeScope: GlobalSearchScope?
    public private(set) var activeQuery = ""
    public private(set) var canLoadMore = false

    @ObservationIgnored private var peopleLoader: PeopleLoader?
    @ObservationIgnored private var messageLoader: MessageLoader?
    @ObservationIgnored private var fileLoader: FileLoader?
    @ObservationIgnored private var nextCursor: String?
    @ObservationIgnored private var seenCursors: Set<String> = []
    @ObservationIgnored private var pageCount = 0
    @ObservationIgnored private var generation: UInt = 0

    typealias PeopleLoader = @Sendable (String, String?) async throws -> GlobalSearchPage<Participant>
    typealias MessageLoader = @Sendable (String, String?) async throws -> GlobalSearchPage<GlobalMessageSearchResult>
    typealias FileLoader = @Sendable (String, String?) async throws -> GlobalSearchPage<GlobalFileSearchResult>

    func configureRemote(
        people: @escaping PeopleLoader,
        messages: @escaping MessageLoader,
        files: @escaping FileLoader
    ) {
        peopleLoader = people
        messageLoader = messages
        fileLoader = files
    }

    public func search(query: String, scope: GlobalSearchScope) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        generation &+= 1
        let requestedGeneration = generation
        resetResults(scope: scope, query: normalized)

        guard !normalized.isEmpty else { return }
        guard scope.isRemote else {
            state = .loaded
            return
        }

        state = .loading
        do {
            try await loadPage(
                query: normalized,
                scope: scope,
                cursor: nil,
                generation: requestedGeneration
            )
        } catch is CancellationError {
            guard generation == requestedGeneration else { return }
            state = .idle
        } catch {
            guard generation == requestedGeneration else { return }
            state = .failed(error.localizedDescription)
        }
    }

    public func loadMore() async {
        guard state != .loading,
              let activeScope,
              activeScope.isRemote,
              !activeQuery.isEmpty,
              let cursor = nextCursor
        else { return }

        let requestedGeneration = generation
        state = .loading
        do {
            try await loadPage(
                query: activeQuery,
                scope: activeScope,
                cursor: cursor,
                generation: requestedGeneration
            )
        } catch is CancellationError {
            guard generation == requestedGeneration else { return }
            state = .loaded
        } catch {
            guard generation == requestedGeneration else { return }
            state = .failed(error.localizedDescription)
        }
    }

    public func retry() async {
        guard let activeScope, !activeQuery.isEmpty else { return }
        if nextCursor != nil, !resultsAreEmpty(for: activeScope) {
            await loadMore()
        } else {
            await search(query: activeQuery, scope: activeScope)
        }
    }

    public func resetForSessionReplacement() {
        generation &+= 1
        peopleLoader = nil
        messageLoader = nil
        fileLoader = nil
        resetResults(scope: nil, query: "")
    }

    private func loadPage(
        query: String,
        scope: GlobalSearchScope,
        cursor: String?,
        generation requestedGeneration: UInt
    ) async throws {
        guard pageCount < Self.maximumPages else {
            nextCursor = nil
            canLoadMore = false
            throw GlobalSearchStoreError.pageLimit
        }
        if let cursor, seenCursors.contains(cursor) {
            nextCursor = nil
            canLoadMore = false
            throw GlobalSearchStoreError.invalidCursor
        }

        switch scope {
        case .people:
            guard let peopleLoader else { throw GlobalSearchStoreError.unavailable }
            let page = try await peopleLoader(query, cursor)
            guard generation == requestedGeneration else { return }
            people = Self.merging(people, page.items)
            try accept(nextCursor: page.nextCursor, requestedCursor: cursor)
            if let cursor { _ = seenCursors.insert(cursor) }
        case .messages:
            guard let messageLoader else { throw GlobalSearchStoreError.unavailable }
            let page = try await messageLoader(query, cursor)
            guard generation == requestedGeneration else { return }
            messages = Self.merging(messages, page.items)
            try accept(nextCursor: page.nextCursor, requestedCursor: cursor)
            if let cursor { _ = seenCursors.insert(cursor) }
        case .media:
            guard let fileLoader else { throw GlobalSearchStoreError.unavailable }
            let page = try await fileLoader(query, cursor)
            guard generation == requestedGeneration else { return }
            files = Self.merging(files, page.items)
            try accept(nextCursor: page.nextCursor, requestedCursor: cursor)
            if let cursor { _ = seenCursors.insert(cursor) }
        case .chats, .channels:
            return
        }

        pageCount += 1
        state = .loaded
    }

    private func accept(nextCursor candidate: String?, requestedCursor: String?) throws {
        if let candidate,
           candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || candidate == requestedCursor
            || seenCursors.contains(candidate)
        {
            nextCursor = nil
            canLoadMore = false
            throw GlobalSearchStoreError.invalidCursor
        }
        nextCursor = candidate
        canLoadMore = candidate != nil
    }

    private func resetResults(scope: GlobalSearchScope?, query: String) {
        activeScope = scope
        activeQuery = query
        people = []
        messages = []
        files = []
        nextCursor = nil
        seenCursors = []
        pageCount = 0
        canLoadMore = false
        state = .idle
    }

    private func resultsAreEmpty(for scope: GlobalSearchScope) -> Bool {
        switch scope {
        case .people: people.isEmpty
        case .messages: messages.isEmpty
        case .media: files.isEmpty
        case .chats, .channels: true
        }
    }

    private static func merging<Item: Identifiable>(_ current: [Item], _ next: [Item]) -> [Item]
    where Item.ID: Hashable {
        var seen = Set(current.map(\.id))
        return current + next.filter { seen.insert($0.id).inserted }
    }
}

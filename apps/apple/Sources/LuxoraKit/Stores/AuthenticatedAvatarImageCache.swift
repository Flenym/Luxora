import Foundation

public actor AuthenticatedAvatarImageCache {
    public typealias Loader = @Sendable (String) async throws -> Data

    private let byteLimit: Int
    private var namespace: String?
    private var loader: Loader?
    private var generation: UInt = 0
    private var cached: [String: Data] = [:]
    private var recency: [String] = []
    private var cachedBytes = 0
    private var operations: [String: Task<Data, Error>] = [:]

    public init(byteLimit: Int = 32 * 1_024 * 1_024) {
        self.byteLimit = max(1, byteLimit)
    }

    /// Installs the loader for one authenticated account at one API origin.
    ///
    /// `namespace` must identify both values (for example
    /// `https://api.example.test|<session-id>`). Keeping it in every cache key
    /// makes the account/origin boundary explicit even though reconfiguration
    /// also clears memory.
    public func configure(namespace: String, loader: @escaping Loader) {
        generation &+= 1
        operations.values.forEach { $0.cancel() }
        operations.removeAll()
        cached.removeAll()
        recency.removeAll()
        cachedBytes = 0
        self.namespace = namespace
        self.loader = loader
    }

    public func data(for path: String) async throws -> Data {
        guard let namespace else { throw AuthenticatedAvatarCacheError.notConfigured }
        let key = Self.cacheKey(namespace: namespace, path: path)
        if let value = cached[key] {
            markRecent(key)
            return value
        }
        if let operation = operations[key] {
            return try await operation.value
        }
        guard let loader else { throw AuthenticatedAvatarCacheError.notConfigured }

        let operationGeneration = generation
        let operation = Task { try await loader(path) }
        operations[key] = operation
        do {
            let value = try await operation.value
            guard generation == operationGeneration, !operation.isCancelled else {
                throw CancellationError()
            }
            operations[key] = nil
            insert(value, for: key)
            return value
        } catch {
            if generation == operationGeneration {
                operations[key] = nil
            }
            throw error
        }
    }

    public func remove(path: String) {
        guard let namespace else { return }
        let key = Self.cacheKey(namespace: namespace, path: path)
        operations[key]?.cancel()
        operations[key] = nil
        if let removed = cached.removeValue(forKey: key) {
            cachedBytes -= removed.count
        }
        recency.removeAll { $0 == key }
    }

    public func clear() {
        generation &+= 1
        operations.values.forEach { $0.cancel() }
        operations.removeAll()
        cached.removeAll()
        recency.removeAll()
        cachedBytes = 0
        namespace = nil
        loader = nil
    }

    private static func cacheKey(namespace: String, path: String) -> String {
        namespace + "\u{0}" + path
    }

    private func insert(_ data: Data, for path: String) {
        guard data.count <= byteLimit else { return }
        if let previous = cached.updateValue(data, forKey: path) {
            cachedBytes -= previous.count
        }
        cachedBytes += data.count
        markRecent(path)
        while cachedBytes > byteLimit, let oldest = recency.first {
            recency.removeFirst()
            if let removed = cached.removeValue(forKey: oldest) {
                cachedBytes -= removed.count
            }
        }
    }

    private func markRecent(_ path: String) {
        recency.removeAll { $0 == path }
        recency.append(path)
    }
}

private enum AuthenticatedAvatarCacheError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        "Загрузка фото профиля недоступна без активного сеанса."
    }
}

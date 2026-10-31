#if os(iOS)
import Foundation
import SwiftUI

// MARK: - Report sheet

/// One-message safety report flow. The reported account is always the author
/// of the selected message; the sheet never lets a reporter pick an arbitrary
/// account. The selected message and the comment are server-readable.
struct PhoneSafetyReportSheet: View {
    @Bindable var store: SafetyReportsStore
    let conversationTitle: String
    let subjectName: String
    let subjectAccountID: UUID
    let messageID: UUID
    let messagePreview: String

    @Environment(\.dismiss) private var dismiss
    @State private var category: SafetyReportCategory = .spam
    @State private var comment = ""
    @State private var alsoBlock = false

    private var trimmedComment: String {
        comment.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var commentCodePoints: Int {
        trimmedComment.unicodeScalars.count
    }

    private var isSubmitting: Bool { store.submitState == .loading }
    private var commentIsValid: Bool {
        commentCodePoints <= SafetyReportLimits.maxCommentCodePoints
    }
    private var submittedReport: SafetyReportSummary? { store.lastSubmittedReport }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "person.crop.circle.badge.exclamationmark")
                            .font(.title2)
                            .foregroundStyle(.orange)
                            .frame(width: 44, height: 44)
                            .background(Color.orange.opacity(0.12), in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Жалоба на \(subjectName)")
                                .font(.body.weight(.semibold))
                            Text("Сообщество: \(conversationTitle)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Выбранное сообщение")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(messagePreview.isEmpty ? "Сообщение без текста" : messagePreview)
                            .font(.callout)
                            .lineLimit(3)
                    }
                } header: {
                    Text("Жалоба")
                } footer: {
                    Text("Будет отправлено одно выбранное сообщение как доказательство. Изменить набор сообщений в этом экране нельзя.")
                }

                Section("Причина") {
                    Picker("Причина", selection: $category) {
                        ForEach(SafetyReportCategory.allCases) { category in
                            Text(category.russianTitle).tag(category)
                        }
                    }
                    .pickerStyle(.menu)
                    .disabled(isSubmitting)
                    .accessibilityIdentifier("safety-report-category")
                }

                Section {
                    TextEditor(text: $comment)
                        .frame(minHeight: 120)
                        .disabled(isSubmitting)
                        .accessibilityIdentifier("safety-report-comment")
                    Text("\(commentCodePoints)/\(SafetyReportLimits.maxCommentCodePoints)")
                        .font(.caption)
                        .foregroundStyle(commentIsValid ? Color.secondary : Color.red)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } header: {
                    Text("Комментарий (необязательно)")
                } footer: {
                    Text("Комментарий прочитает модерация Luxora на сервере.")
                }

                Section {
                    Toggle("Также заблокировать этот аккаунт", isOn: $alsoBlock)
                        .disabled(isSubmitting)
                        .accessibilityIdentifier("safety-report-also-block")
                } footer: {
                    Text("Блокировка скроет переписку и заявки между вами. Она применяется на сервере вместе с жалобой.")
                }

                Section {
                    Label(
                        "На сервер Luxora отправятся выбранное сообщение, его автор, причина и комментарий. Это облачный предпросмотр: сервер может прочитать содержимое — сквозного шифрования (E2EE) нет.",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                if let report = submittedReport {
                    Section {
                        Label("Жалоба отправлена", systemImage: "checkmark.seal.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.green)
                        Text("Номер жалобы: \(report.id.uuidString.prefix(8))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Модерация рассмотрит её. Ответ в этом экране не показывается — сервер присылает только подтверждение.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Готово") { dismiss() }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("safety-report-done")
                    }
                } else if let error = store.submitError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        if store.canRetrySubmission {
                            Button("Повторить отправку") {
                                Task { _ = await store.retrySubmission() }
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("safety-report-retry")
                        }
                        Button("Изменить жалобу") {
                            store.clearSubmissionResult()
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .navigationTitle("Пожаловаться")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if submittedReport == nil {
                        Button("Отправить") { submit() }
                            .fontWeight(.semibold)
                            .disabled(!canSubmit)
                            .accessibilityIdentifier("safety-report-submit")
                    }
                }
            }
            .overlay {
                if isSubmitting {
                    ZStack {
                        Color.black.opacity(0.12).ignoresSafeArea()
                        ProgressView("Отправляем на сервер…")
                            .padding(20)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .accessibilityIdentifier("safety-report-submitting")
                }
            }
            .onAppear { store.clearSubmissionResult() }
            .accessibilityIdentifier("safety-report-screen")
        }
    }

    private var canSubmit: Bool {
        !isSubmitting && commentIsValid && submittedReport == nil
    }

    private func submit() {
        guard canSubmit else { return }
        let normalizedComment = trimmedComment.isEmpty ? nil : trimmedComment
        Task {
            _ = await store.submitReport(
                subjectAccountID: subjectAccountID,
                category: category,
                evidenceMessageIDs: [messageID],
                comment: normalizedComment,
                alsoBlock: alsoBlock
            )
        }
    }
}

// MARK: - Own reports list

struct PhoneSafetyReportsView: View {
    @Bindable var store: SafetyReportsStore

    var body: some View {
        List {
            if store.reports.isEmpty {
                if store.loadState == .loading || store.loadState == .idle {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Загружаем ваши жалобы…")
                                .foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 64)
                        .accessibilityIdentifier("safety-reports-loading")
                    }
                } else if case let .failed(detail) = store.loadState {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Не удалось загрузить жалобы", systemImage: "wifi.exclamationmark")
                                .foregroundStyle(.red)
                            Text(detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button("Повторить") {
                                Task { await store.refresh(force: true) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .accessibilityIdentifier("safety-reports-failed")
                    }
                } else {
                    Section {
                        ContentUnavailableView {
                            Label("Жалоб пока нет", systemImage: "checkmark.shield")
                        } description: {
                            Text("Здесь появятся отправленные вами жалобы. Сервер присылает только подтверждения — без переписки и комментариев.")
                        }
                        .accessibilityIdentifier("safety-reports-empty")
                    }
                }
            } else {
                Section("Ваши жалобы · \(store.reports.count)") {
                    ForEach(store.reports, id: \.id) { report in
                        PhoneSafetyReportRow(report: report)
                    }
                }
                if let paginationError = store.paginationError {
                    Section {
                        Label(paginationError, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        if store.canLoadMore {
                            Button("Повторить") {
                                Task { await store.loadMore() }
                            }
                        }
                    }
                }
                if store.canLoadMore {
                    Section {
                        Button {
                            Task { await store.loadMore() }
                        } label: {
                            HStack(spacing: 8) {
                                if store.isLoadingPage { ProgressView() }
                                Text(store.isLoadingPage ? "Загружаем…" : "Загрузить ещё")
                            }
                        }
                        .disabled(store.isLoadingPage)
                        .accessibilityIdentifier("safety-reports-load-more")
                    }
                } else if case let .failed(detail) = store.loadState {
                    Section {
                        Label("Не удалось обновить список", systemImage: "wifi.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Повторить") {
                            Task { await store.refresh(force: true) }
                        }
                    }
                    .accessibilityIdentifier("safety-reports-refresh-failed")
                }
            }

            Section {
                Label(
                    "Сервер хранит только подтверждение жалобы и не возвращает выбранные сообщения или текст комментария в этот список.",
                    systemImage: "checkmark.shield.fill"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Мои жалобы")
        .refreshable { await store.refresh(force: true) }
        .task {
            if store.loadState == .idle {
                await store.refresh()
            }
        }
        .accessibilityIdentifier("safety-reports-screen")
    }
}

private struct PhoneSafetyReportRow: View {
    let report: SafetyReportSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(report.category.russianTitle)
                    .font(.body.weight(.medium))
                if report.alsoBlocked {
                    Text("Блокировка")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.orange.opacity(0.16), in: Capsule())
                        .foregroundStyle(.orange)
                }
            }
            Text(report.submittedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(
                report.evidenceCount == 1
                    ? "1 сообщение в доказательствах"
                    : "Сообщений в доказательствах: \(report.evidenceCount)"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("safety-report-row-\(report.id.uuidString)")
    }
}

// MARK: - Account data

/// Account data export + account deletion. Both flows are server-owned:
/// nothing is presented as deleted or downloaded until the server confirms it.
struct PhoneAccountDataView: View {
    @Bindable var store: AccountDataStore

    @State private var showsDeletionConfirmation = false
    @State private var typedDeletionConfirmation = ""
    @State private var deletionConfirmationError: String?

    var body: some View {
        List {
            exportSection
            deletionSection
            privacySection
        }
        .navigationTitle("Данные аккаунта")
        .refreshable { await store.loadDeletionStatus(force: true) }
        .task {
            if store.deletionState == .idle {
                await store.loadDeletionStatus()
            }
        }
        .alert("Подтвердите удаление аккаунта", isPresented: $showsDeletionConfirmation) {
            TextField("Введите УДАЛИТЬ", text: $typedDeletionConfirmation)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Отмена", role: .cancel) {
                typedDeletionConfirmation = ""
            }
            Button("Запланировать удаление", role: .destructive) {
                let entered = typedDeletionConfirmation.trimmingCharacters(in: .whitespacesAndNewlines)
                typedDeletionConfirmation = ""
                if entered == "УДАЛИТЬ" {
                    deletionConfirmationError = nil
                    Task { _ = await store.scheduleDeletion() }
                } else {
                    deletionConfirmationError = "Для подтверждения введите УДАЛИТЬ заглавными буквами."
                }
            }
        } message: {
            Text("Удаление начнётся только после семидневного срока. В течение этого срока его можно отменить.")
        }
        .accessibilityIdentifier("account-data-screen")
    }

    // MARK: Export

    private var exportSection: some View {
        Section {
            if let error = store.exportError {
                VStack(alignment: .leading, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    if store.canRetryExportCheck {
                        Button("Проверить состояние") {
                            Task { await store.refreshExportStatus() }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .accessibilityIdentifier("account-export-error")
            }

            if store.exportState == .loading {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(store.exportPollAttempts > 0
                         ? "Сервер собирает архив… попытка \(store.exportPollAttempts)"
                         : "Запрашиваем архив на сервере…")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 56)
                .accessibilityIdentifier("account-export-loading")
            } else if let record = store.exportRecord {
                exportRecordContent(record)
            } else {
                Text("Соберём архив с вашим профилем, чатами, сообщениями и медиафайлами. Токены и секреты не включаются.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Запросить экспорт") {
                    Task { await store.requestExport() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("account-export-request")
            }
        } header: {
            Text("Экспорт данных")
        } footer: {
            Text("Архив собирается на сервере Luxora и скачивается только в текущем сеансе. Готовый архив хранится 7 дней, затем сервер его удаляет.")
        }
    }

    @ViewBuilder
    private func exportRecordContent(_ record: DataExportRecord) -> some View {
        switch record.state {
        case .pending:
            VStack(alignment: .leading, spacing: 8) {
                Label("Архив ещё собирается", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline.weight(.semibold))
                Text("Запрошен \(record.createdAt.formatted(date: .abbreviated, time: .shortened)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Проверить состояние") {
                    Task { await store.refreshExportStatus() }
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("account-export-refresh")
            }
            .accessibilityIdentifier("account-export-pending")
        case .ready:
            VStack(alignment: .leading, spacing: 8) {
                Label("Архив готов", systemImage: "archivebox.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.green)
                if let sizeBytes = record.sizeBytes {
                    Text("Размер: \(Self.byteCount(sizeBytes))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let sha256 = record.sha256 {
                    Text("SHA-256: \(sha256.prefix(16))…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let expiresAt = record.expiresAt {
                    Text("Хранится до \(expiresAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if store.downloadState == .loading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Скачиваем и проверяем архив…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else if let fileURL = store.downloadedExportFileURL {
                    Label("Контрольная сумма проверена на устройстве", systemImage: "checkmark.shield.fill")
                        .font(.footnote)
                        .foregroundStyle(.green)
                    ShareLink(item: fileURL) {
                        Label("Поделиться архивом", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("account-export-share")
                    Button("Скачать заново") {
                        Task { await store.downloadExport() }
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button("Скачать архив") {
                        Task { await store.downloadExport() }
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("account-export-download")
                }
                if let downloadError = store.downloadError {
                    Text(downloadError)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("account-export-download-error")
                }
            }
            .accessibilityIdentifier("account-export-ready")
        case .expired:
            VStack(alignment: .leading, spacing: 8) {
                Label("Срок хранения архива истёк", systemImage: "clock.badge.exclamationmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
                Text("Сервер удалил старый архив. Запросите новый — он соберётся заново.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Запросить новый архив") {
                    Task { await store.requestExport() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("account-export-rebuild")
            }
            .accessibilityIdentifier("account-export-expired")
        }
    }

    // MARK: Deletion

    @ViewBuilder
    private var deletionSection: some View {
        Section {
            if let confirmationError = deletionConfirmationError {
                Label(confirmationError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let actionError = store.deletionActionError {
                Label(actionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("account-deletion-action-error")
            }
            if store.deletionState == .loading, store.deletion == nil {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Проверяем состояние удаления…")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 56)
                .accessibilityIdentifier("account-deletion-loading")
            } else if let deletion = store.deletion {
                deletionContent(deletion)
            } else if case let .failed(detail) = store.deletionState {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Не удалось загрузить состояние удаления", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.red)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Повторить") {
                        Task { await store.loadDeletionStatus(force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("account-deletion-failed")
            }
        } header: {
            Text("Удаление аккаунта")
        } footer: {
            Text("Сервер не удаляет аккаунт мгновенно: сначала семидневный срок, затем удаление выполняется. После срока отменить его нельзя.")
        }
    }

    @ViewBuilder
    private func deletionContent(_ deletion: AccountDeletionRecord) -> some View {
        switch deletion.state {
        case .none:
            if store.lastCanceledDeletion != nil {
                Label("Удаление отменено. Аккаунт продолжает работать.", systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("account-deletion-canceled")
            }
            Text("При удалении сервер завершит все сеансы, обезличит профиль и пометит ваши вложения удалёнными. Сначала действует семидневный срок — его можно отменить.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(role: .destructive) {
                typedDeletionConfirmation = ""
                showsDeletionConfirmation = true
            } label: {
                Label("Запланировать удаление аккаунта…", systemImage: "trash")
            }
            .disabled(store.deletionActionState == .loading)
            .accessibilityIdentifier("account-deletion-schedule")
        case .scheduled:
            Label("Удаление запланировано", systemImage: "calendar.badge.clock")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            if let scheduledAt = deletion.scheduledAt {
                Text("Запланировано \(scheduledAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let graceDeadlineAt = deletion.graceDeadlineAt {
                Text("Удаление выполнится после \(graceDeadlineAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(graceDeadlineAt, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("В течение срока удаление можно отменить. После срока сервер обезличит профиль и завершит сеансы.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if store.deletionActionState == .loading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Отправляем на сервер…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Button("Отменить удаление") {
                    Task { _ = await store.cancelDeletion() }
                }
                .buttonStyle(.bordered)
                .disabled(!store.canCancelDeletion())
                .accessibilityIdentifier("account-deletion-cancel")
                if !store.canCancelDeletion() {
                    Text("Срок отмены истёк — сервер уже выполняет удаление.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        case .deletionPending, .executing:
            Label("Сервер выполняет удаление", systemImage: "hourglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text("Отмена больше невозможна: срок истёк.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .completed:
            Label("Аккаунт удалён", systemImage: "person.crop.circle.badge.xmark")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("Сервер завершил удаление аккаунта.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failedRetryable:
            Label("Удаление ожидает повторной попытки", systemImage: "arrow.clockwise.circle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text("Сервер повторит попытку удаления. Отмена недоступна.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Privacy facts

    private var privacySection: some View {
        Section {
            Label(
                "Облачный предпросмотр: сервер может прочитать сообщения, вложения и текст жалобы — сквозного шифрования (E2EE) нет.",
                systemImage: "exclamationmark.shield.fill"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Label(
                "В экспорт входят профиль, настройки, сеансы, связи, блокировки, чаты, сообщения и медиафайлы. Токены и секреты помечаются как исключённые.",
                systemImage: "archivebox"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Label(
                "Удаление аккаунта сначала проходит семидневный срок; после него действия необратимы.",
                systemImage: "trash.slash"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        } header: {
            Text("Что важно знать")
        }
    }

    private static func byteCount(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
#endif

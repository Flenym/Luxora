import LuxoraKit
import SwiftUI

// These views live only in LuxoraDesignLab. They communicate the intended
// product direction without shipping inactive controls in LuxoraMobile.

struct ConceptConversationMediaView: View {
    var body: some View {
        NavigationStack {
            ZStack {
                ConceptPalette.canvas.ignoresSafeArea()
                ScrollView {
                    LazyVStack(spacing: 12) {
                        Text("Today")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(LuxoraTheme.ink.opacity(0.68))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(.white.opacity(0.82), in: Capsule())

                        ConceptTextBubble(
                            text: "The launch motion is ready. I left two notes on the timing.",
                            time: "12:41",
                            outgoing: false
                        )
                        ConceptVoiceBubble()
                        ConceptTextBubble(
                            text: "Perfect — send the short preview too.",
                            time: "12:45",
                            outgoing: true
                        )
                        ConceptVideoBubble()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 16)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ConceptRichComposer()
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 9) {
                        ConceptAvatar(initials: "MC", size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Mira Chen")
                                .font(.subheadline.weight(.semibold))
                            Text("online")
                                .font(.caption2)
                                .foregroundStyle(LuxoraTheme.success)
                        }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Image(systemName: "phone.fill")
                    Image(systemName: "video.fill")
                }
            }
        }
        .accessibilityIdentifier("concept-conversation-media-screen")
    }
}

private struct ConceptTextBubble: View {
    let text: String
    let time: String
    let outgoing: Bool

    var body: some View {
        HStack(alignment: .bottom) {
            if outgoing { Spacer(minLength: 56) }
            VStack(alignment: .leading, spacing: 6) {
                Text(text)
                    .font(.body)
                Text(time)
                    .font(.caption2)
                    .foregroundStyle(outgoing ? Color.white.opacity(0.72) : Color.gray)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .foregroundStyle(outgoing ? Color.white : LuxoraTheme.ink)
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background {
                if outgoing {
                    LuxoraTheme.brandGradient
                } else {
                    RoundedRectangle(cornerRadius: 19, style: .continuous)
                        .fill(.white)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
            .shadow(color: .black.opacity(0.04), radius: 10, y: 4)
            if !outgoing { Spacer(minLength: 56) }
        }
    }
}

private struct ConceptVoiceBubble: View {
    private let bars: [CGFloat] = [9, 16, 24, 13, 28, 19, 11, 22, 31, 16, 26, 12, 18, 8]

    var body: some View {
        HStack {
            HStack(spacing: 9) {
                ZStack {
                    Circle().fill(LuxoraTheme.accent)
                    Image(systemName: "play.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 38, height: 38)

                HStack(alignment: .center, spacing: 2) {
                    ForEach(Array(bars.enumerated()), id: \.offset) { _, height in
                        Capsule()
                            .fill(LuxoraTheme.accent.opacity(0.7))
                            .frame(width: 3, height: height)
                    }
                }
                VStack(alignment: .trailing, spacing: 2) {
                    Text("0:12")
                        .font(.caption.weight(.semibold))
                    Text("12:43")
                        .font(.caption2)
                        .foregroundStyle(Color.gray)
                }
            }
            .foregroundStyle(LuxoraTheme.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: .black.opacity(0.04), radius: 10, y: 4)
            Spacer(minLength: 48)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Concept voice message, 12 seconds")
    }
}

private struct ConceptVideoBubble: View {
    var body: some View {
        HStack {
            Spacer(minLength: 72)
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 23, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [LuxoraTheme.deepViolet, LuxoraTheme.electricBlue, .black],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(height: 164)
                    .overlay(alignment: .topLeading) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Motion preview")
                                .font(.headline)
                            Text("Video message · concept")
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.68))
                        }
                        .foregroundStyle(.white)
                        .padding(16)
                    }
                    .overlay {
                        Image(systemName: "play.fill")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 54, height: 54)
                            .background(.white.opacity(0.16), in: Circle())
                    }
                Text("0:08")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(.black.opacity(0.5), in: Capsule())
                    .padding(11)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Concept video message, 8 seconds")
    }
}

private struct ConceptRichComposer: View {
    var body: some View {
        VStack(spacing: 9) {
            HStack(spacing: 8) {
                ConceptComposerAction(title: "Photo", symbol: "photo.fill")
                ConceptComposerAction(title: "File", symbol: "doc.fill")
                ConceptComposerAction(title: "Camera", symbol: "camera.fill")
                ConceptComposerAction(title: "Location", symbol: "location.fill")
            }

            HStack(alignment: .bottom, spacing: 9) {
                Image(systemName: "plus")
                    .font(.body.weight(.bold))
                    .frame(width: 38, height: 38)
                    .background(LuxoraTheme.accent.opacity(0.12), in: Circle())
                    .foregroundStyle(LuxoraTheme.accent)

                HStack(spacing: 8) {
                    Text("Message")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Image(systemName: "face.smiling")
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 13)
                .frame(minHeight: 42)
                .background(.background, in: Capsule())

                Image(systemName: "mic.fill")
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(LuxoraTheme.brandGradient, in: Circle())

                Image(systemName: "video.fill")
                    .foregroundStyle(LuxoraTheme.accent)
                    .frame(width: 38, height: 38)
                    .background(LuxoraTheme.accent.opacity(0.12), in: Circle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Divider() }
        .accessibilityIdentifier("concept-rich-composer")
    }
}

private struct ConceptComposerAction: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(LuxoraTheme.accent)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(LuxoraTheme.accent.opacity(0.1), in: Capsule())
    }
}

struct ConceptCallView: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color.black, LuxoraTheme.deepViolet.opacity(0.9), Color.black],
                startPoint: .top,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(LuxoraTheme.violet.opacity(0.2))
                .frame(width: 420, height: 420)
                .blur(radius: 55)
                .offset(y: -150)

            VStack(spacing: 0) {
                HStack {
                    Label("End-to-end encryption planned", systemImage: "lock.slash")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    Spacer()
                    Image(systemName: "rectangle.inset.filled.and.person.filled")
                }
                .foregroundStyle(.white)

                Spacer()

                ConceptAvatar(initials: "MC", size: 128)
                    .overlay(Circle().stroke(.white.opacity(0.22), lineWidth: 1))
                    .shadow(color: LuxoraTheme.violet.opacity(0.5), radius: 28)
                Text("Mira Chen")
                    .font(.system(size: 31, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.top, 22)
                Text("00:42 · HD audio concept")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.62))
                    .padding(.top, 7)

                Spacer()

                HStack(spacing: 24) {
                    ConceptCallControl(title: "Mute", symbol: "mic.slash.fill")
                    ConceptCallControl(title: "Video", symbol: "video.fill")
                    ConceptCallControl(title: "Speaker", symbol: "speaker.wave.2.fill", selected: true)
                }

                HStack(spacing: 44) {
                    ConceptCallControl(title: "More", symbol: "ellipsis", compact: true)
                    VStack(spacing: 8) {
                        Image(systemName: "phone.down.fill")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 72, height: 72)
                            .background(Color.red, in: Circle())
                        Text("End")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.74))
                    }
                    ConceptCallControl(title: "Chat", symbol: "bubble.left.fill", compact: true)
                }
                .padding(.top, 32)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 22)
        }
        .accessibilityIdentifier("concept-call-screen")
    }
}

private struct ConceptCallControl: View {
    let title: String
    let symbol: String
    var selected = false
    var compact = false

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.title3.weight(.semibold))
                .foregroundStyle(selected ? LuxoraTheme.ink : .white)
                .frame(width: compact ? 54 : 62, height: compact ? 54 : 62)
                .background(selected ? .white : .white.opacity(0.14), in: Circle())
            Text(title)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.76))
        }
        .frame(minWidth: 72)
    }
}

struct ConceptContactsSearchView: View {
    private let people = [
        ("MC", "Mira Chen", "@mira", true),
        ("NS", "Noah Stone", "@noah", true),
        ("AI", "Ava Ito", "@ava", false),
        ("RK", "Roman Kim", "@roman", false),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ConceptSearchField()

                    VStack(alignment: .leading, spacing: 13) {
                        HStack {
                            Text("Quick contacts")
                                .font(.headline)
                            Spacer()
                            Text("Address book permission")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 18) {
                            ForEach(Array(people.prefix(4).enumerated()), id: \.offset) { _, person in
                                VStack(spacing: 7) {
                                    ConceptAvatar(initials: person.0, size: 54, online: person.3)
                                    Text(person.1.components(separatedBy: " ").first ?? person.1)
                                        .font(.caption)
                                        .lineLimit(1)
                                }
                                .frame(maxWidth: .infinity)
                            }
                        }
                    }

                    HStack(spacing: 8) {
                        ConceptFilterChip(title: "People", selected: true)
                        ConceptFilterChip(title: "Messages")
                        ConceptFilterChip(title: "Media")
                        ConceptFilterChip(title: "Files")
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("People on Luxora")
                            .font(.headline)
                        ForEach(Array(people.enumerated()), id: \.offset) { _, person in
                            HStack(spacing: 12) {
                                ConceptAvatar(initials: person.0, size: 46, online: person.3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.1).font(.subheadline.weight(.semibold))
                                    Text(person.2)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "message.fill")
                                    .foregroundStyle(LuxoraTheme.accent)
                                    .frame(width: 36, height: 36)
                                    .background(LuxoraTheme.accent.opacity(0.1), in: Circle())
                            }
                            .padding(12)
                            .background(.background, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                        }
                    }

                }
                .padding(16)
            }
            .background(ConceptPalette.canvas)
            .navigationTitle("People & search")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: "person.badge.plus")
                        .foregroundStyle(LuxoraTheme.accent)
                }
            }
        }
        .accessibilityIdentifier("concept-contacts-search-screen")
    }
}

private struct ConceptSearchField: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            Text("Search people, chats and files")
                .foregroundStyle(.secondary)
            Spacer()
            Image(systemName: "mic.fill")
                .foregroundStyle(LuxoraTheme.accent)
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(.background, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(.primary.opacity(0.08))
        }
    }
}

private struct ConceptFilterChip: View {
    let title: String
    var selected = false

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(selected ? .white : .secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(selected ? AnyShapeStyle(LuxoraTheme.accent) : AnyShapeStyle(.background), in: Capsule())
    }
}

struct ConceptProfileSettingsView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 10) {
                        ConceptAvatar(initials: "AM", size: 88, online: true)
                        Text("Alex Morgan")
                            .font(.title2.weight(.bold))
                        Text("@alex · Beta-0.1")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            Label("Edit profile", systemImage: "pencil")
                            Label("Share", systemImage: "qrcode")
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(LuxoraTheme.accent)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)

                    ConceptSettingsCard(title: "Account") {
                        ConceptSettingsRow(symbol: "person.text.rectangle", title: "Identity & username", detail: "Available")
                        ConceptSettingsRow(symbol: "iphone.gen3", title: "Devices", detail: "Limited")
                        ConceptSettingsRow(symbol: "key.fill", title: "Passkeys", detail: "Unavailable")
                    }

                    ConceptSettingsCard(title: "Privacy & safety") {
                        ConceptSettingsRow(symbol: "lock.shield.fill", title: "Encryption", detail: "Planned")
                        ConceptSettingsRow(symbol: "hand.raised.fill", title: "Blocked accounts", detail: "Concept")
                        ConceptSettingsRow(symbol: "exclamationmark.shield.fill", title: "Reports", detail: "Server-backed")
                    }

                    ConceptSettingsCard(title: "Experience") {
                        ConceptSettingsRow(symbol: "bell.badge.fill", title: "Notifications", detail: "Push gated")
                        ConceptSettingsRow(symbol: "circle.lefthalf.filled", title: "Appearance", detail: "System")
                        ConceptSettingsRow(symbol: "accessibility", title: "Accessibility", detail: "Defaults")
                    }

                    Text("Developer & owner · Flenym")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .background(ConceptPalette.canvas)
            .navigationTitle("Profile & settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .accessibilityIdentifier("concept-profile-settings-screen")
    }
}

private struct ConceptSettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.bottom, 8)
            VStack(spacing: 0) { content }
                .background(.background, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        }
    }
}

private struct ConceptSettingsRow: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(LuxoraTheme.accent)
                .frame(width: 34, height: 34)
                .background(LuxoraTheme.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            Text(title)
                .font(.subheadline.weight(.medium))
            Spacer()
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 55)
        .overlay(alignment: .bottom) {
            Divider().padding(.leading, 59)
        }
    }
}

struct ConceptLoadingView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(
                colors: [LuxoraTheme.deepViolet.opacity(0.2), .clear],
                center: .center,
                startRadius: 10,
                endRadius: 270
            )
            .ignoresSafeArea()

            VStack(spacing: 26) {
                Spacer()
                ConceptInvisibleLogoLoader()
                    .frame(width: 250, height: 250)
                    .accessibilityLabel("Two lights travelling in the same direction around the invisible Luxora contour")
                VStack(spacing: 8) {
                    Text("Preparing Luxora")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("Two lights · one direction · the mark stays invisible")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.48))
                }
                Spacer()
                Text("Beta-0.1")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.34))
                    .padding(.bottom, 18)
            }
        }
        .accessibilityIdentifier("concept-loading-screen")
    }
}

private struct ConceptInvisibleLogoLoader: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 3.2) / 3.2
            Canvas { context, size in
                let rect = CGRect(origin: .zero, size: size).insetBy(dx: 24, dy: 18)
                let path = invisibleLogoContour(in: rect)
                draw(trace: path, phase: phase, in: &context, size: size)
                draw(trace: path, phase: (phase + 0.5).truncatingRemainder(dividingBy: 1), in: &context, size: size)
            }
        }
    }

    private func draw(
        trace path: Path,
        phase: Double,
        in context: inout GraphicsContext,
        size: CGSize
    ) {
        let lower = max(0, phase - 0.17)
        let segment = path.trimmedPath(from: lower, to: phase)
        context.addFilter(.shadow(color: LuxoraTheme.violet.opacity(0.9), radius: 12))
        context.stroke(
            segment,
            with: .linearGradient(
                Gradient(colors: [.clear, LuxoraTheme.electricBlue, .white]),
                startPoint: CGPoint(x: 0, y: size.height),
                endPoint: CGPoint(x: size.width, y: 0)
            ),
            style: StrokeStyle(lineWidth: 6, lineCap: .round)
        )
        if let point = segment.currentPoint {
            let dot = CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)
            context.fill(Path(ellipseIn: dot), with: .color(.white))
        }
    }

    private func invisibleLogoContour(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }

        var path = Path()
        path.move(to: point(0.54, 0.03))
        path.addCurve(to: point(0.34, 0.66), control1: point(0.41, 0.15), control2: point(0.28, 0.48))
        path.addCurve(to: point(0.09, 0.82), control1: point(0.27, 0.72), control2: point(0.14, 0.72))
        path.addCurve(to: point(0.26, 0.97), control1: point(0.05, 0.91), control2: point(0.12, 0.99))
        path.addCurve(to: point(0.92, 0.69), control1: point(0.48, 0.89), control2: point(0.76, 0.9))
        path.addCurve(to: point(0.48, 0.64), control1: point(0.98, 0.59), control2: point(0.67, 0.59))
        path.addCurve(to: point(0.54, 0.03), control1: point(0.43, 0.48), control2: point(0.62, 0.08))
        path.closeSubpath()
        return path
    }
}

struct ConceptComponentBoardView: View {
    @State private var notifications = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    ConceptBoardSection(title: "Actions") {
                        HStack(spacing: 9) {
                            Text("Primary")
                                .conceptButton(foreground: .white, background: AnyShapeStyle(LuxoraTheme.brandGradient))
                            Text("Secondary")
                                .conceptButton(foreground: LuxoraTheme.accent, background: AnyShapeStyle(LuxoraTheme.accent.opacity(0.1)))
                            Text("Delete")
                                .conceptButton(foreground: .red, background: AnyShapeStyle(Color.red.opacity(0.09)))
                        }
                        HStack(spacing: 11) {
                            ForEach(["plus", "camera.fill", "mic.fill", "video.fill", "paperplane.fill"], id: \.self) { symbol in
                                Image(systemName: symbol)
                                    .foregroundStyle(symbol == "paperplane.fill" ? .white : LuxoraTheme.accent)
                                    .frame(width: 42, height: 42)
                                    .background(symbol == "paperplane.fill" ? AnyShapeStyle(LuxoraTheme.brandGradient) : AnyShapeStyle(LuxoraTheme.accent.opacity(0.1)), in: Circle())
                            }
                        }
                    }

                    ConceptBoardSection(title: "State chips") {
                        HStack(spacing: 7) {
                            ConceptStatusChip(title: "Online", color: LuxoraTheme.success, symbol: "checkmark.circle.fill")
                            ConceptStatusChip(title: "Connecting", color: LuxoraTheme.electricBlue, symbol: "arrow.triangle.2.circlepath")
                            ConceptStatusChip(title: "Unavailable", color: .secondary, symbol: "lock.fill")
                        }
                    }

                    ConceptBoardSection(title: "Composer states") {
                        HStack(spacing: 9) {
                            Image(systemName: "plus")
                                .foregroundStyle(LuxoraTheme.accent)
                            Text("Write a message")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Image(systemName: "face.smiling")
                            Image(systemName: "mic.fill")
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(LuxoraTheme.accent, in: Circle())
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 48)
                        .background(ConceptPalette.canvas, in: Capsule())

                        HStack(spacing: 9) {
                            Circle()
                                .fill(Color.red)
                                .frame(width: 8, height: 8)
                            Text("Recording voice · 0:07")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text("Cancel")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Image(systemName: "paperplane.fill")
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(LuxoraTheme.accent, in: Circle())
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 48)
                        .background(ConceptPalette.canvas, in: Capsule())
                    }

                    ConceptBoardSection(title: "Controls & delivery") {
                        Toggle("Notifications", isOn: $notifications)
                            .tint(LuxoraTheme.accent)
                        HStack {
                            Label("Sending", systemImage: "clock")
                            Spacer()
                            Label("Delivered", systemImage: "checkmark")
                            Spacer()
                            Label("Read", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(LuxoraTheme.accent)
                        }
                        .font(.caption.weight(.semibold))
                    }

                    ConceptBoardSection(title: "Loading motion") {
                        HStack(spacing: 14) {
                            ConceptInvisibleLogoLoader()
                                .frame(width: 74, height: 74)
                                .background(Color.black, in: RoundedRectangle(cornerRadius: 18))
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Invisible contour")
                                    .font(.subheadline.weight(.semibold))
                                Text("Two light points travel in the same direction and never meet.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .padding(14)
            }
            .background(ConceptPalette.canvas)
            .navigationTitle("Component board")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("concept-component-board-screen")
    }
}

private struct ConceptBoardSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
    }
}

private struct ConceptStatusChip: View {
    let title: String
    let color: Color
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(color.opacity(0.1), in: Capsule())
    }
}

private struct ConceptAvatar: View {
    let initials: String
    let size: CGFloat
    var online = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(LuxoraTheme.brandGradient)
                .overlay {
                    Text(initials)
                        .font(.system(size: size * 0.3, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                }
                .frame(width: size, height: size)
            if online {
                Circle()
                    .fill(LuxoraTheme.success)
                    .frame(width: max(10, size * 0.22), height: max(10, size * 0.22))
                    .overlay(Circle().stroke(.background, lineWidth: 2))
            }
        }
    }
}

private enum ConceptPalette {
    static let canvas = Color(uiColor: .systemGroupedBackground)
}

private extension View {
    func conceptButton(
        foreground: Color,
        background: AnyShapeStyle
    ) -> some View {
        self
            .font(.caption.weight(.semibold))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .frame(height: 38)
            .background(background, in: Capsule())
    }
}

# Luxora iPhone — live account security and avatar evidence

Captured from the signed `LuxoraMobile` Debug app on the iPhone 17e Simulator
against the real local Docker API on 2026-08-11.

- Device sessions: `1/1` UI test passed. The server returned the current and
  remote sessions, and the remote session disappeared only after server revoke.
- Phone password: `1/1` UI test passed. The existing phone account required its
  password after OTP, rejected an invalid password, accepted the correct one,
  changed the password, and then disabled it on the server.
- Profile avatar: `1/1` UI test passed. The app cropped and resumably uploaded a
  generated PNG, restored the server avatar after terminating/relaunching the
  app, and cleared it from the server.
- All ten PNGs were reviewed at original resolution. Exact disposable phone,
  OTP, current/replacement password, and debug-password canaries were absent
  from the retained screenshots and passing result bundles.

The APNs delivery provider remains disabled by the server capability flag; the
client/server token-registration and synchronized preference foundation is a
separate implementation checkpoint and is not claimed by these screenshots.

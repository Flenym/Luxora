# Локальный canary-scan iOS evidence

Дата: 11 августа 2026 года.

- Текстовые `.json`/`.txt` вложения проверены на `Authorization`, Bearer,
  password/OTP/secret-поля, JWT, полный российский номер и private-key headers:
  совпадений нет.
- Метаданные семи PNG проверены: только системное описание `Screenshot`, без GPS,
  автора и `WhereFroms`.
- Все семь PNG открыты в исходном размере 1206×2622 и просмотрены вручную.
- На экранах нет введённого номера, OTP, пароля, токена или реального секретного
  контента. Имена, сообщения и `@flenym` относятся к детерминированному локальному
  UI-test fixture.
- Raw quarantine-вложения содержат только синтетические тексты пяти fixture-
  сообщений и описание системного accessibility issue.

Это локальная проверка экспортированных iOS-артефактов. Она не заменяет серверный
log/content/token canary и не делает claims о production ingress, traces или crash
reporting.

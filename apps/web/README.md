# Luxora Web

Маркетинговый сайт и интерактивный web-клиент Luxora на React, TypeScript и Vite.

- Владелец и разработчик: **Flenym**
- Текущий релиз: **Beta-0.1**

## Локальный запуск

```bash
npm install
npm run dev
```

Vite откроет приложение на `http://localhost:4173`. Маркетинговый сайт доступен по `/`, messenger shell — по `/app`.

## Проверки

```bash
npm run typecheck
npm run build
npm run preview
```

## Реализованные сценарии

- адаптивный продуктовый сайт: возможности, безопасность, загрузки, журнал, документация, FAQ и поддержка;
- тёмная и светлая темы с сохранением выбора;
- список чатов с папками, поиском, непрочитанными и online-состояниями;
- отправка сообщений и локальное прикрепление файлов;
- реакции, delivery/read state, pinned message и typing state;
- честные roadmap-состояния для ещё не подключённых звонков, E2EE и multi-device;
- отдельный мобильный navigation flow «список чатов → разговор»;
- клавиатурный focus, семантические landmarks, live regions и `prefers-reduced-motion`.

Демо Beta-0.1 работает локально и хранит разговор в состоянии текущей вкладки. Оно не заявляет server sync, push, звонки или E2EE как готовые функции. Для production-синхронизации UI ожидает подключение к realtime API Luxora; per-device E2EE должно пройти отдельную реализацию и аудит.

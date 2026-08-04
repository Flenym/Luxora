# Accepted Telegram-reference concepts

> **Исторический acceptance log, superseded 2026-08-04.** Все перечисленные ниже assets относятся к прежнему 10-screen pass и не являются текущими принятыми файлами. Актуальный набор состоит из 62 неизменяемых пользовательских исходников; см. [`FULL_REFERENCE_INVENTORY_RU.md`](FULL_REFERENCE_INVENTORY_RU.md). Новые Luxora ImageGen-результаты принимаются только в `generated_full_reference_ru/`.

**QA date:** 2026-08-04  
**Boundary:** built-in ImageGen reference studies only. These raster boards are not application screenshots, implementation proof or pixel-match evidence.

| File | Size | SHA-256 | Accepted QA |
| --- | ---: | --- | --- |
| `01-chats-baseline-ru-v3.png` | 852×1846 | `7bdd89da3a7279c0a0352504c85a302186ff67f3bf25306b6342bf0492a2c7af` | Russian 4+search shell; three-avatar header stack; one shared three-action capsule; folder overflow; idle island; dense chat rows |
| `02-chats-status-rail-ru-v2.png` | 853×1844 | `f818a20f8c364014a093d82609813082bb7625e015cebacbf8f188fd8c5495fd` | Expanded status state; status and folder rails visibly clipped; shared actions; idle island |
| `03-contacts-baseline-ru-v4.png` | 853×1844 | `4c34dcaee93bcf2729bfb9e40711108a9870dd79a2405b544af11dba1202fd8a` | Russian contacts; about eleven rows; А–Я/# index; idle island has no false media outline |
| `04-chat-list-edit-baseline-ru-v3.png` | 852×1846 | `cd2394cf4d497009ca9375e939c4672fba3e484a31773d4b20d66553ed1162d2` | Edit mode; 60-pt-class avatars; 72–78-pt-class rows; about 6.7 visible rows; selection/reorder/bulk actions |
| `05-direct-chat-baseline-ru-v2.png` | 853×1844 | `6b8cd8fe017f82480462ed309dabf4af96a79a0c2850f4b71a4d4a2113452949` | Russian mixed-message conversation; pin/reply/video/composer geometry; synthetic media; idle island |
| `06-contact-profile-baseline-ru-v1.png` | 853×1844 | `c58f9919d3109b00835760f2c0f06ccafd3a6d70e97c42977e64cb908c48f9f2` | Nested contact profile; five quick actions; privacy-safe data; clipped content scopes; three-column synthetic media grid; no root shell |

## Shared acceptance rules

- All visible product copy is Russian and all people/content are synthetic.
- No Telegram name, paper-plane mark, verified/Premium treatment or copied personal screenshot data is accepted.
- The root shell is exactly **Контакты / Звонки / Чаты / Настройки** plus separate circular **Поиск**.
- A normal screen uses an idle matte-black Dynamic Island. Source-screen media activity was accidental and is not part of the Luxora reference state.
- Status and folder rows are horizontal carousels. The partial right-edge item communicates overflow; a still bitmap does not prove the swipe gesture.
- ImageGen output dimensions differ from the binding 1179×2556 geometry gate. Only a real Simulator PNG at 1179×2556 can enter runtime visual-diff QA.

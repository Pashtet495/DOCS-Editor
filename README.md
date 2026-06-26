# DOCS-Editor
A SuperDOC-based text editor that packages DOCX-compatible documents into the new DOCS container format, which includes a document map with preserved embedding vectors and the ability to store ts and js scripts used in the document. Designed for collaborative editing (human + AI) and for RAG searching without creating external vector databases.

**При создании форков или иных копий учитывайте лицензию на использование SuperDOC редактора**. 

SuperDoc is available under dual licensing:
    Open Source: [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)
    Commercial: [Enterprise License](https://www.harbourshare.com/request-a-demo)

**Программа находиться на ранних этапах разработки**

Поддержка открытия docx документов. Динамическое чанкование и эмбеддинг документа. Встроен ИИ помощник для редактирования документа. Встроена возможность генерации при помощи ИИ canvas подобных вставок в документ. Карта документа с эмбеддингами и скриптами сохраняются в новый формат файлов DocS (Document+script).
<img width="512" height="512" alt="icon" src="https://github.com/user-attachments/assets/39070f17-ce12-40de-9e73-7ab0904892f9" />

Выше представлен черновик возможного логотипа формата (игра слов на созвучии "Doc S" и "dog ass").
**Структура формата файлов и карты документа ещё не финальные.**

Подключение к нейросетям осуществляется через OpenAI API совместимый протокол. Настройки по умолчанию для сервера LM Studio. Необходимо две нейросети. Одна для генерации текста, вторая для генерации эмбеддингов.

### Рекомендуемые нейросети

Рекомендуемая минимальная нейросеть для генерации: https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF в квантовании не ниже UD-Q2-K-XL.
Для генерации эмбеддингов проверена с https://huggingface.co/unsloth/embeddinggemma-300m-GGUF (с квантизацией Q4_0).

### Ключевые возможности

- Открытие docx документов
- Редактирование документов (таблицы, списки, форматирование текста и т.д.)
- ИИ помощник (переписывание частей документа, дописывание, перемещение частей документа) с поддержкой понимания контекста (можно просто просить что-то исправить обычным языком, нейросеть в малых документах знает весь контекст и карту документа, в больших документах ищет нужные части документа через векторный поиск)
- Сохранение документа в формате docs. Форматирование документа остаётся docx совместимым. Внутри контейнера docs файла лежит docx документ.

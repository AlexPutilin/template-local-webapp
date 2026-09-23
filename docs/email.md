# Email Feature

## Purpose

The email feature under `src/framework/email/` sends messages through the locally installed Microsoft Outlook application.

```text
src/framework/email/
├─ sendOutlookMail.js   → validates options and starts PowerShell
└─ SendOutlookMail.ps1  → creates, displays, or sends the Outlook message
```

The JavaScript function returns a Promise. It prepares recipient values and encoded message content, then invokes the PowerShell script.

## Email Flow

```text
Application service or task
→ sendOutlookMail()
→ PowerShell script
→ Outlook message
→ display or send
```

## Usage

```js
import sendOutlookMail from '#framework/email/sendOutlookMail.js';

const result = await sendOutlookMail({
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    subject: 'Daily report',
    body: 'The daily report is ready.',
    bodyType: 'text',
    attachments: [],
    displayOnly: true
});

console.log(result.message);
```

With `displayOnly: true`, Outlook displays the prepared message instead of sending it. With the default value `false`, the script sends the message.

## Function Parameters

`sendOutlookMail(options)` accepts one options object:

| Parameter | Type | Required | Default | Description |
|---|---|---:|---|---|
| `from` | `string` | yes | none | Sender address used by Outlook for `SentOnBehalfOfName`. |
| `to` | `string \| string[]` | yes | none | Primary recipient or list of recipients. Arrays are joined with semicolons. |
| `cc` | `string \| string[]` | no | `[]` | Carbon-copy recipient or list of recipients. |
| `bcc` | `string \| string[]` | no | `[]` | Blind-carbon-copy recipient or list of recipients. |
| `subject` | `string` | yes | none | Message subject. |
| `body` | `string` | yes | none | Message body. |
| `bodyType` | `'text' \| 'html'` | no | `'text'` | Selects the plain-text or HTML Outlook body property. |
| `attachments` | `string[]` | no | `[]` | File paths added as attachments. Missing files cause the operation to fail. |
| `displayOnly` | `boolean` | no | `false` | Displays the prepared message instead of sending it. |

## Return Value

The function resolves with an object containing the PowerShell output:

```js
{
    message: 'Mail displayed successfully.',
    error: ''
}
```

The Promise rejects when validation fails, PowerShell cannot start, an attachment is missing, Outlook reports an error, or the PowerShell process exits unsuccessfully.

## Validation

The JavaScript function checks the following values before starting PowerShell:

- `from` must be provided.
- `to` must contain at least one recipient.
- `subject` must be a string.
- `body` must be a string.
- `bodyType` must be either `text` or `html`.

## Email Conventions

- Email infrastructure belongs under `framework/email/`.
- Project-specific message content and recipient selection belong in application services or tasks.
- Await `sendOutlookMail()` and handle rejected Promises where the caller needs custom error handling.
- Use `displayOnly: true` when the message should be reviewed in Outlook before sending.
- Attachment entries must be valid file paths.

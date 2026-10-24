# Contributing

Never commit session files, tokens, HAR captures, voucher codes, or real phone numbers, emails, ID numbers or order numbers. Tests use made-up values and recorded shapes only.

```sh
npm install
npm run check
```

Anything that spends money (buying a voucher) must stay behind a quote and a confirm token, so a client can only buy after the user agreed to a specific voucher and price.

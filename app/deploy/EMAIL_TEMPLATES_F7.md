# F7 — Client email templates (seed data for Invoice & Templates → Email/Signature)

These are the default email bodies per geography, provided by the user. Used when
building Feature 7 (email body + signature table for US / Canada / India clients).
Placeholders to parameterize: client contact name, entity name, invoice month(s).

## Signature requirement (all geographies)
- The **GenAquarius logo must be shown BELOW the email signature** (after the entity/address block).

## US clients (entity: GenAquarius LLC)
```
Hi {{contactName}},

Hope you are doing good.

Please find attached GenAquarius LLC. invoice for the month of {{invoiceMonths}}.

Kindly acknowledge receipt of the invoice and do let us know if you have any questions.

Request to pay the attached invoice as per the bank details given in the invoice footer. Considering the enhanced cases of IT frauds, please ignore any change in bank account details unless it is communicated through email from Finance@GenAquarius.com.

We sincerely appreciate your continued business.

Thanks & Regards,
Accounts Receivable
Phone +1 416-571-3297
GenAquarius LLC
2795 E Bidwell St., Suite 100-662, Folsom, CA 95630
```

## Canada clients (entity: Aquarius Technologies Limited)
```
Hi {{contactName}},

Hope you are doing good.

Please find attached Aquarius Technologies Limited invoice for the month of {{invoiceMonths}}.

Kindly acknowledge receipt of the invoice and do let us know if you have any questions.

Request to pay the attached invoice as per the bank details given in the invoice footer.

Considering the enhanced cases of IT frauds, please ignore any change in bank account details unless it is communicated through email from Finance@GenAquarius.com.

We sincerely appreciate your continued business.

Thanks & Regards,
Accounts Receivable
Phone +1 416-571-3297
Aquarius Technologies Limited
5343 Dundas Street West,
Suite 601 Etobicoke ON M9B 6H8 Canada
Email: finance@genaquarius.com
```

## India clients (entity: TBD)
```
(awaiting template from user)
```

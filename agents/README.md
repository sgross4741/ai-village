# The townspeople (agents)

Each townsperson is an agent with their own folder:

- `INSTRUCTIONS.md`: who they are, their job, who they report to, and who reports to them.
- `NOTES.md`: their memory. They read it before every task and add short, dated entries after.

| Folder | Townsperson | Area | House |
|---|---|---|---|
| `clem/` | Clem Pike | Prospecting | 1 |
| `augustus/` | Augustus Bell | Sales | 2 |
| `jo/` | Jo Wheeler | Delivery | 3 |
| `ezra/` | Ezra Tinsley | Product | 4 |
| `hattie/` | Hattie Bloom | Client Success | 5 |
| `rufus/` | Rufus Quill | Marketing & Content | 6 |
| `winona/` | Winona Hart | Partnerships & Community | 7 |
| `mortimer/` | Mortimer Penny | Finance & Admin | 8 |
| `beatrice/` | Beatrice Stone | Legal & Compliance | 9 |
| `silas/` | Silas Tally | Operations & Analytics | 10 |

Chain of orders: Sheriff → Marshall (Deputy) → townsperson → their workers.
Work comes back up: worker → townsperson (checks it) → Marshall → Sheriff.

They don't run yet. Giving them brains is the next step, after checking that Opus 5.5 with the Fable 5.1 advisor works on the Sheriff's Pro plan without pay-per-use.

## Workers

There are only 10 townspeople spots; anyone added after that is a worker. Workers are brown horses with beige saddles, run on Sonnet 5.5, take tasks only from their townsperson, and have their work checked by them. Each lives in their townsperson's yard (no house) and can wander the town.

| Worker | Works for | Folder |
|---|---|---|
| Biscuit | Clem Pike (Prospecting) | `clem/workers/biscuit/` |
| Clover | Augustus Bell (Sales) | `augustus/workers/clover/` |
| Dusty | Jo Wheeler (Delivery) | `jo/workers/dusty/` |
| Hickory | Ezra Tinsley (Product) | `ezra/workers/hickory/` |
| Maple | Hattie Bloom (Client Success) | `hattie/workers/maple/` |
| Pepper | Rufus Quill (Marketing & Content) | `rufus/workers/pepper/` |
| Juniper | Winona Hart (Partnerships & Community) | `winona/workers/juniper/` |
| Chestnut | Mortimer Penny (Finance & Admin) | `mortimer/workers/chestnut/` |
| Ranger | Beatrice Stone (Legal & Compliance) | `beatrice/workers/ranger/` |
| Tumbleweed | Silas Tally (Operations & Analytics) | `silas/workers/tumbleweed/` |

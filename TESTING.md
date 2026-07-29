# Testing the price-masking, standby, offline and costing work

Two halves. The script proves the data and the rules; the checklist covers what only a person with a
phone can see. Run the script first — if it fails, the UI will too.

```bash
npm run verify                        # every check, read-only
npm run verify -- --staff STAFF003    # exactly what one person can and cannot see
```

**The script writes nothing.** It reads real records and runs the masking, apportionment and
averaging logic over copies held in memory. `npm run test:workflow` is the opposite — it advances
real tasks and generates real recurring inquiries, so keep it for seeded data.

A `WARN` usually means "no data of this kind yet" and is expected on a database where the feature
has not been used. A `FAIL` is a real defect.

---

## Before you start

Two accounts, so you can see both sides:

- an **Admin** (STAFF005 Nilesh) — sees everything
- a **price-masked** account (STAFF003 Amit, role `Staff`) — sees no money

To mask someone else: **Admin → Module Access → that person → Prices & Financials → Hidden**.

Today only Amit is masked; both Supervisors can see prices. That is deliberate — they could see
prices before this change, and silently taking that away would have been a regression rather than a
feature. Hide them per person if you want that.

---

## 1. Price masking

Log in as the **masked** user.

| Where | Expect |
|---|---|
| Inventory → Items | No Rate column, on both the phone cards and the desktop table |
| Inventory → Export CSV | The downloaded file has **no `Standard_Rate` column** |
| Inventory → edit an item | No "Standard rate" field. Save, then check as Admin that **the rate is unchanged** |
| Any delivery challan | No rate, amount or total anywhere |
| DevTools → Network → any challan or item request | **No `Rate` or `Amount` in the JSON at all** |

That last row is the real test. The others are cosmetic; this one proves the figures never reached
the device.

Now log in as **Admin** and confirm the opposite: quotations, invoices, price list and PDFs all show
money exactly as before. Any change here is a bug — the Admin path was meant to be untouched.

**Impersonation.** As Admin, impersonate the masked user. Prices should disappear. This is a preview
of their screen, not a privilege drop: the server still answers as you and still sends the figures,
and the UI hides them. Anything genuinely confidential should not rely on it.

---

## 2. Standby loaners

On a job card, **Service tab → Standby units → Issue standby units**.

1. Enter two EUIDs (type them, or scan). Leave the gate pass blank on one.
2. Issue them.
   - Both appear as `OUT`
   - The blank gate pass has been **filled in automatically** with a `GP…` number
   - If the units map to catalogue items, stock drops by two
3. Issue a challan for that job card → a warning appears, which you **can** acknowledge and continue.
   Advisory on purpose: the driver usually collects the loaner on arrival.
4. Open Delivery and try to sign → **blocked**. This one is absolute.
5. Tick **one** unit → *Confirm 1 received back*. One returns, one still blocks.
6. On the last one, tap **Customer is keeping this**.
   - With the reason box empty → refused
   - With a reason → the delivery unblocks and the signature pad unlocks

Then check as Admin that the customer's timeline shows a **Standby Retained** entry in amber with
that reason. Retention is the only way past the block, so it is meant to be visible afterwards.

---

## 3. Offline proof of delivery

The one screen most likely to be used with no signal.

1. Open an issued challan on a phone or in DevTools.
2. **Go offline** (DevTools → Network → Offline, or turn off mobile data).
3. Record the delivery: sign, name, photo.
4. Expect *"Saved on this device — it will sync when you are back online."* and a pending-sync count.
5. **Go back online.** The queue drains and the delivery is recorded.
6. Reload and confirm it saved **once** — not twice.

Step 6 matters: a replayed POD must not insert a second copy of the signature and photos.

---

## 4. Partial delivery

From a job card with **two or more** cylinders, create a challan.

- You are asked which are going back, everything ticked
- **Continue with all** → a normal challan, *not* marked partial
- Untick one → the button says *partial challan*, and only the ticked cylinders appear

"All ticked" must behave exactly as it did before this picker existed. A single-cylinder job card
skips the question entirely.

---

## 5. Equipment categories

**Admin → Equipment Types.**

- Add a category (e.g. Foam) with its own checkpoints → it appears in the job card type dropdown
- Reopen an existing one: **Code is read-only**, and so is each existing checkpoint **id**
- The **label** is editable — change one and confirm old job cards still read correctly

Ids are storage keys on every inspected cylinder; labels are what technicians read. That is why one
is locked and the other is not.

---

## 6. Purchase and landed cost

**Admin → Purchase.**

1. **Vendors** → add two or three.
2. **Enquiries** → new enquiry, pick items and vendors.
3. Record each vendor's reply, then **Compare quotes**:
   - ranked L1 / L2 / L3, cheapest first, L1 highlighted
   - the line-by-line table marks the cheapest **per item**, which is not always the overall winner
4. **Raise order** on one → a PO number from the counter.
5. **Receive** it: enter quantities, a vendor invoice number, and freight.

Then check the arithmetic:

- stock rises by what you received
- **Inventory → stock value = quantity × average cost** for that item
- with freight entered, the landed cost is **higher** than the vendor's rate
- receive less than ordered → recorded as short, order stays *Partially Received*, not rejected

Freight is spread **by value, not by quantity** — on fifty cheap pins and two expensive valves, most
of the freight belongs to the valves.

**As a masked user**, the receiving screen should show quantities, the invoice number and the star
rating, but **no freight field and no rates**. Prices on a receipt always come from the purchase
order, so someone who cannot see a price cannot set one.

---

## Known, and fine

- **Four items show negative stock.** Pre-existing. `deductForInvoice` deliberately allows it rather
  than blocking an invoice already sent to a customer. Worth correcting with a stock adjustment,
  because a negative quantity resets the cost basis on the next receipt.
- **One standby unit has no gate pass.** Issued before gate passes were minted. Harmless.
- **Nothing is costed yet.** Cost builds from the first goods receipt onward; it cannot be
  backfilled from history that never recorded a purchase price.

## If something looks wrong

`npm run verify` names the check that failed. For a UI problem, the useful question is whether the
figure is **missing from the JSON** (server did its job, a screen needs fixing) or **present in the
JSON but hidden on screen** (masking gap — that one matters).

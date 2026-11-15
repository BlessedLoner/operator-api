# StripPals security rollout

Run SQL in Supabase → SQL Editor. One block at a time, test, then continue.
Every block has an undo.

## Done already
- Helper checks `is_manager()` / `is_admin()`
- Step 2: users can't change their own `role`
- Step 3: `send_message_with_credits` takes sender from the login, fixed price 1 credit
- Step 3b: removed public "insert message" / "backend" conversation rules

## Order from here
1. **Run `2-batch2-lockdown.sql`** (safe with the current apps).
   Test: credit store shows packages; like, sign-up and message → operator still work;
   operators of each type log in; manager-app Operators / Security Alerts / Reports open.
2. **Railway → operator-api → Variables**
   - `OPERATOR_JWT_SECRET` = 40+ random characters (required, operator login is off without it).
     Generate one on your own computer: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
     and paste it only into Railway. Never commit or share it. Changing it later logs every operator out.
   - `CORS_ORIGINS` = `https://strippals.com,https://www.strippals.com,https://chatoperatorservice.com,https://www.chatoperatorservice.com,https://chatservicemanager.com,https://www.chatservicemanager.com`
3. **Main site (stripMe) changes** — these pages must send the login token, or they stop working
   after step 4:
   - `src/pages/admin/AdminUsers.jsx`, `src/pages/admin/CityManagement.jsx`: every `fetch` to
     operator-api gets the header
     `Authorization: \`Bearer ${(await supabase.auth.getSession()).data.session.access_token}\``
   - `src/pages/CreditStore.jsx` (`create-session`): same header; body only needs `package_id`.
4. **Deploy together**: operator-api, operator-app, manager-app (+ the stripMe change).
   Everyone is logged out once.
   Test: operator login (each type), waiting room → chat → reply, new user message appears
   within ~4 s, poke dashboard stats, outreach; manager login, every manager page;
   site admin pages (/admin, /admin/users, /admin/cities).
5. **Run `3-final-lockdown.sql` one section (C1…C6) at a time**, testing after each:
   - C1–C3: sign up a new user (poke queue gets them), like a profile, operator photos/logbooks.
   - C4: user chat + live replies; operator still receives messages.
   - C5: everything a user sees about *their own* profile (settings, navbar, chat list);
     admin suspend/unsuspend.
   - C6: like, block/unblock, chat unread markers, report a profile, gallery photos,
     pricing page, members page (states), admin page (likes, state neighbours, private photos).
   If a section breaks something, run that section from `4-final-undo.sql`.
6. **Last**: rotate the Supabase service-role key (update it in Railway), and reset every
   operator password (the old hashes were readable).

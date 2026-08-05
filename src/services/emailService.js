const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendNewMessageEmail({ email, displayName, senderName }) {
  try {
    await resend.emails.send({
      from: "StripPals <notifications@YOURDOMAIN.com>",
      to: email,
      subject: `${senderName} sent you a new message 💌`,
      html: `
        <div style="font-family:Arial;padding:30px">
            <h2>Hello ${displayName},</h2>

            <p>
                You have received a new message on StripPals.
            </p>

            <p>
                Come back now before the conversation goes cold.
            </p>

            <a href="https://strippals.com/chat"
               style="
               display:inline-block;
               background:#e91e63;
               color:white;
               padding:12px 20px;
               border-radius:8px;
               text-decoration:none;">
               Open Chat
            </a>

            <p style="margin-top:30px;color:#888;">
                You're receiving this because you have a StripPals account.
            </p>
        </div>
      `,
    });

    console.log("Email sent.");
  } catch (err) {
    console.error(err);
  }
}

module.exports = {
  sendNewMessageEmail,
};

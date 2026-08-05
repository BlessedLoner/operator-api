import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendNewMessageEmail({
  to,
  senderName,
  senderAge,
  senderLocation,
  senderPhoto,
  preview,
}) {
  try {
    const response = await resend.emails.send({
      from: "StripPals <onboarding@resend.dev>",

      to,

      subject: `${senderName} sent you a new message 💌`,

      html: `
      <div style="
          max-width:600px;
          margin:auto;
          font-family:Arial,sans-serif;
          background:#ffffff;
          border-radius:12px;
          overflow:hidden;
          border:1px solid #eee;
      ">

          <div style="
              background:#d63384;
              padding:25px;
              text-align:center;
              color:white;
          ">
              <h1 style="margin:0;">StripPals</h1>
          </div>

          <div style="padding:30px;">

              ${
                senderPhoto
                  ? `
              <div style="text-align:center;margin-bottom:20px;">
                  <img
                      src="${senderPhoto}"
                      style="
                          width:110px;
                          height:110px;
                          border-radius:50%;
                          object-fit:cover;
                      "
                  />
              </div>
              `
                  : ""
              }

              <h2 style="text-align:center;margin-bottom:5px;">
                  ${senderName}
                  ${senderAge ? `, ${senderAge}` : ""}
              </h2>

              ${
                senderLocation
                  ? `
              <p style="
                  text-align:center;
                  color:#777;
                  margin-top:0;
              ">
                  📍 ${senderLocation}
              </p>
              `
                  : ""
              }

              <p style="font-size:16px;">
                  Someone is waiting for your reply.
              </p>

              ${
                preview
                  ? `
              <div style="
                  background:#f7f7f7;
                  border-left:4px solid #d63384;
                  padding:15px;
                  margin:20px 0;
                  font-style:italic;
              ">
                  "${preview.substring(0, 100)}"
              </div>
              `
                  : ""
              }

              <div style="text-align:center;margin-top:30px;">
                  <a
                      href="https://strippals.com/chat"
                      style="
                          display:inline-block;
                          background:#d63384;
                          color:white;
                          padding:14px 30px;
                          text-decoration:none;
                          border-radius:8px;
                          font-weight:bold;
                      "
                  >
                      Continue Conversation
                  </a>
              </div>

              <p style="
                  color:#888;
                  margin-top:40px;
                  font-size:13px;
                  text-align:center;
              ">
                  You're receiving this because you have a StripPals account.
              </p>

          </div>

      </div>
      `,
    });

    console.log("✅ Email sent:", response);

    return response;
  } catch (err) {
    console.error("❌ Email error:", err);
    throw err;
  }
}

export { sendNewMessageEmail };

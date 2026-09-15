require("dotenv").config({ quiet: true });

const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} = require("firebase/auth");
const { getDatabase, ref, push, get } = require("firebase/database");

// FloodSense AI layer — see agents/ and docs/ARCHITECTURE.md
const orchestrator = require("./agents/orchestrator");
const { summariseIncident } = require("./agents/incidentAgent");
const { isVillage, listVillages } = require("./lib/villages");

const app = express();
const port = process.env.PORT || 4000;

// Firebase configuration. These were committed to source in the 2024 build.
// Firebase web keys are public by design — the real access control is the
// Realtime Database security rules — but committing them still meant the
// project could not be pointed at a different backend without a code edit.
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Per-visitor sessions.
 *
 * The 2024 build read `auth.currentUser` from the Firebase *client* SDK inside
 * Express route handlers. That object is a single module-level global in one
 * Node process, so every visitor to the deployed site shared one identity —
 * whoever logged in most recently was "the current user" for everybody, and
 * requireAuth was effectively a global on/off switch rather than a per-user
 * check. Login state now lives in the request session, where it belongs.
 */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "floodsense-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8,
      secure: process.env.NODE_ENV === "production",
    },
  })
);

const requireAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    next(); // User is authenticated, proceed to the next middleware
  } else {
    res.redirect("/"); // Redirect to login page if user is not authenticated
  }
};

/** Display name for the header, preserving the 2024 behaviour of trimming the domain. */
const displayEmail = (req) =>
  req.session && req.session.user ? req.session.user.email.replace("@gmail.com", " ") : "";

app.use(express.static("public"));

app.set("views", __dirname + "/views");
app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Define the reference to the 'adminForms' node in the database
const adminFormRef = ref(database, "adminForms");

app.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send("Email and password are required.");
  }

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      const user = userCredential.user;
      const isAdmin = ADMIN_EMAILS.includes(String(user.email).toLowerCase());

      // Bind the identity to THIS visitor's session, not to a process global.
      req.session.user = { uid: user.uid, email: user.email, isAdmin };

      if (isAdmin) {
        res.redirect("/admin");
      } else {
        res.redirect("/landing"); // Redirect non-admin users to home page
      }
    })
    .catch((signInError) => {
      let errorMessage = "";
      if (signInError.code === "auth/user-not-found") {
        errorMessage = "User not found. Please sign up.";
      } else if (signInError.code === "auth/wrong-password") {
        errorMessage = "Invalid password. Please try again.";
      } else if (signInError.code === "auth/invalid-credential") {
        errorMessage = "invalid credentials or just make sure you have signed up";
      } else if (signInError.code === "auth/invalid-email") {
        errorMessage = "invalid email ";
      } else {
        errorMessage = "Error signing in. Please try again later.";
      }
      console.error("Error signing in:", signInError.message);
      // Sending error message back to the client
      res.status(500).render("login", { errorMessage: errorMessage });
    });
});

// Render sign-up page
app.get("/signup", (req, res) => {
  res.render("signup", { errorMessage: "" }); // Pass an empty string as the initial value
});

// Handle sign-up request
app.post("/signup", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send("Email and password are required.");
  }

  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      const user = userCredential.user;
      // Sign the new user in for this session. The 2024 build rendered "home"
      // directly without establishing any session, so every nav link on that
      // page bounced the brand-new user straight back to the login screen.
      req.session.user = {
        uid: user.uid,
        email: user.email,
        isAdmin: ADMIN_EMAILS.includes(String(user.email).toLowerCase()),
      };
      res.redirect("/landing");
    })
    .catch((signUpError) => {
      let errorMessage = "Error signing up. Please try again later.";
      console.error("Error signing up:", signUpError.message);
      if (signUpError.code === "auth/email-already-in-use") {
        errorMessage = "Email is already in use. Please use a different email.";
      }
      // Sending error message back to the client
      res.status(500).render("signup", { errorMessage: errorMessage });
    });
});

const requireAdminAuth = (req, res, next) => {
  const user = req.session && req.session.user;

  // Check if user is authenticated
  if (!user) {
    return res.redirect("/"); // Redirect to login page if user is not authenticated
  }

  // Admin status was decided at login against ADMIN_EMAILS and stored on the
  // session, so it cannot be spoofed by a later request.
  if (user.isAdmin) {
    return next();
  }

  res.status(403).send("Access forbidden");
};


app.get("/forgot-password", (req, res) => {
  res.render("forgotPass", { errorMessage: "" }); // Pass an empty string as the initial value
});

// Render login page
app.get("/", (req, res) => {
  res.render("login", { errorMessage: "" }); // Pass an empty string as the initial value
});

app.get("/landing", requireAuth, (req, res) => {
  res.render("landingPage", {
    errorMessage: "",
    email: displayEmail(req),
  });
});

app.get("/villages", requireAuth, (req, res) => {
  res.render("home", {
    errorMessage: "",
    email: displayEmail(req),
    // First paint is model-free: the page renders instantly from the
    // deterministic reading, then fetches AI assessments per village.
    snapshot: orchestrator.quickSnapshot(),
  });
});

// const generateRandomWaterLevel = () => Math.round(Math.random() * 20 + 80);
// const generateRandomWaterLevel = () => Math.round(Math.random() * 20 + 180);

// const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// const saveRandomValueToDatabase = async (
//   villageName,
//   monthKey,
//   dayKey,
//   hour,
//   minute
// ) => {
//   const timeKey = `${hour.toString().padStart(2, "0")}:${minute
//     .toString()
//     .padStart(2, "0")}`;
//   const randomValue = generateRandomWaterLevel();

//   // Save the value to the database under the specified village, month, day, hour, and minute
//   try {
//     const userRef = ref(
//       database,
//       `VillageList/${villageName}/${monthKey}/${dayKey}/${timeKey}`
//     );
//     // usersRef.child('yourVillageName').update({ name: newName })

//     await set(userRef, randomValue);
//     console.log(
//       `${villageName}/${monthKey}/${dayKey}/${timeKey}:`,
//       randomValue,
//       "Value added to the database"
//     );
//   } catch (error) {
//     console.log("Error saving value to the database:", error);
//   }
// };
// app.get("/village", async (req, res) => {
//   const villageName = "mangarh"; // Replace with the actual village name

//   for (let month = 1; month <= 12; month++) {
//     const monthKey = `month${month}`;

//     for (let day = 1; day <= 30; day++) {
//       const dayKey = `day${day}`;

//       for (let hour = 0; hour < 24; hour++) {
//         for (let minute = 0; minute < 60; minute += 10) {
//           await saveRandomValueToDatabase(
//             villageName,
//             monthKey,
//             dayKey,
//             hour,
//             minute
//           );
//           await wait(1); // Adjust the wait time here (in milliseconds)
//         }
//       }
//     }
//   }

//   res.send("Values added to the database.");
// });

// Call the function to update the name value
app.get("/contact",requireAuth, (req, res) => {
  res.render("contact", {
    errorMessage: "",
    email: displayEmail(req),
  });
});

app.get("/about",requireAuth, (req, res) => {
  res.render("about", {
    errorMessage: "",
    email: displayEmail(req),
    messages: null,
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Handle forgot password request.
// requireAuth was on this route in the 2024 build, which meant you had to be
// logged in to reset the password you had forgotten. Removed.
app.post("/forgot-password", (req, res) => {
  const { email } = req.body;

  sendPasswordResetEmail(auth, email)
    .then(() => {
      res.send("Password reset email sent. Check your inbox.");
    })
    .catch((error) => {
      console.error("Error sending password reset email:", error);
      res.status(500).send("Error sending password reset email.");
    });
});

app.get("/admin", requireAuth, requireAdminAuth, (req, res) => {
  // The 2024 build used onValue() here. onValue registers a PERSISTENT
  // subscription, so every later write to adminForms re-fired this callback and
  // called res.render() again on an already-sent response — crashing the server
  // with ERR_HTTP_HEADERS_SENT as soon as anyone submitted the contact form
  // while an admin had this page open. get() is the one-shot read this wanted.
  get(adminFormRef)
    .then((snapshot) => {
      res.render("admin", {
        formData: snapshot.val(),
        email: displayEmail(req),
      });
    })
    .catch((error) => {
      console.error("The read failed:", error.message);
      res.status(500).send("Failed to retrieve form data.");
    });
});

app.post("/submit-contact",requireAuth, (req, res) => {
  const formData = req.body;

  // Push form data to Firebase Realtime Database
  push(adminFormRef, formData)
    .then(() => {
      res.render("about", {
        errorMessage: "",
        email: displayEmail(req),
        messages: "form data saved ",
      }); // Rendering the "about" page after form submission
    })
    .catch((error) => {
      console.error("Error saving form data:", error);
      res.status(500).send("Failed to save form data.");
    });
});

/* ------------------------------------------------------------------------ *
 *  FloodSense AI API
 *
 *  These are the routes the villages page calls to populate its AI panel.
 *  Assessments are cached per village inside the orchestrator, so a page
 *  refresh does not spend money; ?refresh=1 forces a fresh agent run.
 * ------------------------------------------------------------------------ */

/** Model-free snapshot of every village. Instant, free, always available. */
app.get("/api/snapshot", requireAuth, (req, res) => {
  res.json({ villages: orchestrator.quickSnapshot() });
});

/** Full agent assessment for one village. */
app.get("/api/assess/:village", requireAuth, async (req, res) => {
  const { village } = req.params;
  if (!isVillage(village)) {
    return res.status(404).json({
      error: `Unknown village "${village}"`,
      known: listVillages().map((v) => v.id),
    });
  }
  try {
    const result = await orchestrator.assessVillage(village, {
      refresh: req.query.refresh === "1",
    });
    res.json(result);
  } catch (error) {
    // The orchestrator degrades internally rather than throwing, so reaching
    // here means something unexpected broke. Say so plainly.
    console.error(`[api] assessment failed for ${village}:`, error);
    res.status(500).json({ error: "Assessment failed", detail: error.message });
  }
});

/** After-action report built from the assessments recorded for a village. */
app.get("/api/incident/:village", requireAuth, async (req, res) => {
  const { village } = req.params;
  if (!isVillage(village)) {
    return res.status(404).json({ error: `Unknown village "${village}"` });
  }
  const events = orchestrator.getEventLog(village);
  if (events.length === 0) {
    return res.status(409).json({
      error: "No assessments recorded for this village yet",
      hint: `Call /api/assess/${village} first — the incident report is built from that history.`,
    });
  }
  const { report, error, trace } = await summariseIncident({ villageId: village, events });
  if (error) {
    return res.status(503).json({ error: "Incident report unavailable", detail: error.message, trace });
  }
  res.json({ villageId: village, report, trace });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`FloodSense listening on http://localhost:${port}`);
  });
}

module.exports = app;

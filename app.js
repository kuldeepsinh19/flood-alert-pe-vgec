const express = require("express");
const bodyParser = require("body-parser");
const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} = require("firebase/auth");
const app = express();
const port = 3000;

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyA6_Fls-zrOp1JTSvEFPNkVUf7iOeg7TXU",
  authDomain: "waterlevel-c2a1b.firebaseapp.com",
  projectId: "waterlevel-c2a1b",
  storageBucket: "waterlevel-c2a1b.appspot.com",
  messagingSenderId: "940376979833",
  appId: "1:940376979833:web:4622066a99cbfe86ee97a8",
  measurementId: "G-NL86V4999M",
};
const firebaseApp = initializeApp(firebaseConfig);

const auth = getAuth(firebaseApp);

app.use(express.static("public"));

app.set("views", __dirname + "/views");
app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send("Email and password are required.");
  }

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      const user = userCredential.user;
      console.log(user);
      res.render("home");
    })
    .catch((signInError) => {
      let errorMessage = "";
      if (signInError.code === "auth/user-not-found") {
        errorMessage = "User not found. Please sign up.";
      } else if (signInError.code === "auth/wrong-password") {
        errorMessage = "Invalid password. Please try again.";
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
      console.log("User signed up:", user);
      res.render("home");
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
app.get("/forgot-password", (req, res) => {
  res.render("forgotPass", { errorMessage: "" }); // Pass an empty string as the initial value
});
// Render login page
app.get("/", (req, res) => {
  res.render("login", { errorMessage: "" }); // Pass an empty string as the initial value
});

app.get("/landing", (req, res) => {
  res.render("landingPage", {
    errorMessage: "",
  });
});
app.get("/villages", (req, res) => {
  res.render("home", {
    errorMessage: "",
  });
});
app.get("/contact", (req, res) => {
  res.render("contact", {
    errorMessage:''
  })
})

// Handle forgot password request
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

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

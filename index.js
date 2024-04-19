const express = require("express");
const bodyParser = require("body-parser");
const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} = require("firebase/auth");
const { getDatabase, set, ref, push, onValue } = require("firebase/database"); // Import necessary database functions
const { doc } = require("firebase/firestore");

const app = express();
const port = 4000;

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
const database = getDatabase(firebaseApp);

const auth = getAuth(firebaseApp);

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
      console.log(user);
      if (email === "kuldeepsinhrajput1919@gmail.com") {
        // If the user is an admin, redirect to admin page
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
  const user = auth.currentUser;

  res.render("landingPage", {
    errorMessage: "",
    email: user ? user.email.replace("@gmail.com", " ") : "",
  });
});

app.get("/villages", (req, res) => {
  // const user =  auth.currentUser

  res.render("home", {
    errorMessage: "",
    // email:user?user.email.replace('@gmail.com' , ' '):''
  });
});

// const generateRandomWaterLevel = () => Math.round(Math.random() * 20 + 80);
const generateRandomWaterLevel = () => Math.round(Math.random() * 20 + 180);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const saveRandomValueToDatabase = async (
  villageName,
  monthKey,
  dayKey,
  hour,
  minute
) => {
  const timeKey = `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
  const randomValue = generateRandomWaterLevel();

  // Save the value to the database under the specified village, month, day, hour, and minute
  try {
    const userRef = ref(
      database,
      `VillageList/${villageName}/${monthKey}/${dayKey}/${timeKey}`
    );
    // usersRef.child('yourVillageName').update({ name: newName })

    await set(userRef, randomValue);
    console.log(
      `${villageName}/${monthKey}/${dayKey}/${timeKey}:`,
      randomValue,
      "Value added to the database"
    );
  } catch (error) {
    console.log("Error saving value to the database:", error);
  }
};
app.get("/village", async (req, res) => {
  const villageName = "mangarh"; // Replace with the actual village name

  for (let month = 1; month <= 12; month++) {
    const monthKey = `month${month}`;

    for (let day = 1; day <= 30; day++) {
      const dayKey = `day${day}`;

      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 10) {
          await saveRandomValueToDatabase(
            villageName,
            monthKey,
            dayKey,
            hour,
            minute
          );
          await wait(1); // Adjust the wait time here (in milliseconds)
        }
      }
    }
  }

  res.send("Values added to the database.");
});

// Call the function to update the name value
app.get("/contact", (req, res) => {
  const user = auth.currentUser;

  res.render("contact", {
    errorMessage: "",
    email: user ? user.email.replace("@gmail.com", " ") : "",
  });
});

app.get("/about", (req, res) => {
  const user = auth.currentUser;

  // Initialize messages variable to null
  let messages = null;

  res.render("about", {
    errorMessage: "",
    email: user ? user.email.replace("@gmail.com", " ") : "",
    messages: messages, // Pass the messages to the template
  });
});

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

app.get("/admin", (req, res) => {
  const user = auth.currentUser;

  onValue(
    adminFormRef,
    (snapshot) => {
      const formData = snapshot.val();
      res.render("admin", {
        formData: formData,
        email: user ? user.email.replace("@gmail.com", " ") : "",
      });
    },
    (errorObject) => {
      console.log("The read failed: " + errorObject.code);
      res.status(500).send("Failed to retrieve form data.");
    }
  );
});
app.post("/submit-contact", (req, res) => {
  const formData = req.body;
  const user = auth.currentUser;

  // Push form data to Firebase Realtime Database
  push(adminFormRef, formData)
    .then(() => {
      const message = "form data saved ";
      res.render("about", {
        email: user.email.replace("@gmail.com", " "),
        messages: message,
      }); // Rendering the "about" page after form submission
    })
    .catch((error) => {
      console.error("Error saving form data:", error);
      res.status(500).send("Failed to save form data.");
    });
});

app.listen(process.env.PORT || 4000);

module.exports = app;

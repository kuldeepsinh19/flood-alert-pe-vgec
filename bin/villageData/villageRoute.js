// // import { FirebaseApp } from "firebase/app";
// // import { Database } from "firebase/database";
// // import { database } from "../../app";
// // const express = require("express");
// // // import { App } from "firebase-admin/app";

const { onValue } = require("firebase/database")
const { format } = require("morgan")

// // import { app } from "../../app";

// let myCurrentValue; // Variable to store the current random value

// const generateRandomWaterLevel = () => {
//     const randomDecimal = Math.random();
//     const randomValue = (randomDecimal * 20) + 80;
//     return Math.round(randomValue);
// }

// const logWaterLevel = (value, message) => {
//     console.log(value, message);
// }

// // Set up an interval to log random water level values every second
// const intervalId = setInterval(() => {
//     myCurrentValue = generateRandomWaterLevel();
//     logWaterLevel(myCurrentValue, "Random Water Level");
// }, 1000);

// // Log a single random water level value after 5 seconds
// setTimeout(() => {
//     clearInterval(intervalId);
//     logWaterLevel(myCurrentValue, "My Current Value");
//     console.log("Interval cleared after 5 seconds.");

//     // Export the value after the interval has been cleared
//     module.exports = {
//         myCurrentValue
//     };
// }, 5000);


//     console.log(myCurrentValue , "vilage se")







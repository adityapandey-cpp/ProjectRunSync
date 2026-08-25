const mongoose = require('mongoose');

const runSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: [true, 'userId is required'],
    index: true,
  },
  type: {
    type: String,
    enum: {
      values: ['easy', 'long', 'tempo', 'speed'],
      message: '{VALUE} is not a supported run type',
    },
    required: [true, 'Run type is required'],
  },
  distance: {
    type: Number,
    required: [true, 'Distance (km) is required'],
    min: [0.01, 'Distance must be greater than 0'],
  },
  time: {
    type: Number,
    required: [true, 'Time (seconds) is required'],
    min: [1, 'Time must be greater than 0'],
  },
  avgPace: {
    type: Number, // seconds per km
  },
  date: {
    type: Date,
    default: Date.now,
  },
});

// Auto-compute avgPace (sec/km) whenever it isn't explicitly supplied,
// or whenever distance/time change.
runSchema.pre('validate', function preValidate(next) {
  if (this.distance && this.time) {
    if (this.avgPace === undefined || this.avgPace === null || this.isModified('distance') || this.isModified('time')) {
      this.avgPace = this.time / this.distance;
    }
  }
  next();
});

runSchema.index({ userId: 1, date: -1 });

module.exports = mongoose.model('Run', runSchema);

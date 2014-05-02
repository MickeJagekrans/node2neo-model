'use strict';

var Schema = require('node2neo-schema');
// var hooks = require('hooks');
var Neo4jError = Schema.error;


/**
 * The Model constuctor
 * @param {Node2Neo} db The Node2Neo instance for this database
 */
function ModelHolder (db) {
  this.db = db;
}

/**
 * Create a new model with an optional schema. Models contain functions for creating, updating, removing and reading objects.
 * The model is returned in a callback as the optional indexing requires an async transaction.
 *
 * @param  {String}   label    The name of the Model
 * @param  {Object}   schema   The schema object - for options see node2neo-schema
 * @param  {Object}   options  Options for creating the schema - see node2neo-schema
 * @param  {Function} callback
 * @return {[type]}            [description]
 */
ModelHolder.prototype.model = function (label, schema, options) {

  if(!options){
    options = {};
  }
  options.label = label;

  if(typeof schema === 'undefined'){
    // default to an empty, non-strict schema
    schema = new Schema({}, { strict:false, label: label});
  }

  if (schema.constructor.name !== 'Schema') {
    schema = new Schema(schema, options);
  }

  // create teh model and apply the default pre and post hooks
  var model = new Model(label, this.db, schema);


  /*!
   * Set up middleware support
   */

  // for (var k in hooks) {
  //   model[k] = hooks[k];
  // }
  // // model.hook('create', Model.prototype.create);
  // // model.hook('update', Model.prototype.update);
  // // model.hook('remove', Model.prototype.remove);

  // model.pre('create', function(next, node, options, callback){
  //   if(this.schema._indexes.length > 0 || this.schema._constraints.length > 0){
  //     this.applyIndexes(function(err){
  //       if(err) next(err);

  //       else {
  //         // console.log('indexes', node, options);
  //         next(node, options, callback);
  //       }
  //     });
  //   }
  //   else {
  //     // console.log('no indexes', node, options);
  //     next(node, options, callback);
  //   }
  // });

  return model;
};


/**
 * Model constructor
 * @param {String} label  The label of the model
 * @param {Object} db     The Node2Neo instance
 * @param {Schema} schema The model schema
 */
function Model (label, db, schema){
  // should we support multiple labels?
  this.label = label;

  //inherit the db from the parent
  this.db = db;

  // set the schema
  this.schema = schema;

  // set the sub-schemas
  this._subSchemas = Object.keys(schema._subSchemas);

  // apply statics
  for (var i in schema.statics) {
    this[i] = schema.statics[i];
  }
}


/**
 * When creating hooks you must pass the arguments through to the relveant function
 *
 * Model.pre('create, function(next, node, options, callback){
 *   // manipulate node / options
 *   next(node, options, callback)
 * })
 * Model.pre('update, function(next, node, updates, options, callback){
 *   // manipulate node / updates/ options
 *   next(node, updates, options, callback)
 * })
 * Model.pre('create, function(next, id, options, callback){
 *   // manipulate id / options
 *   next(id, options, callback)
 * })
 */

/**
 * Apply the indexes to the Model
 * @param  {Model}   self     The model for which the indexes should be applied
 * @param  {Function} callback
 * @return {Model}            The model is returned
 */
Model.prototype.applyIndexes = function(callback){
  this.label = this.label.split(":").slice(-1)[0]; // handles subtypes

  var self = this;
  var consLen = self.schema._constraints.length;
  var indLen = self.schema._indexes.length;
  if(consLen || indLen){
    var transStatement = [];
    for(var i=0; i<consLen; i++){
      transStatement.push({statement: 'CREATE CONSTRAINT ON (node:' + self.label + ') ASSERT node.' + self.schema._constraints[i] + ' IS UNIQUE'});
    }
    for(var j=0; j<indLen; j++){
      transStatement.push({statement: 'CREATE INDEX ON :' + self.label + '(' + self.schema._indexes[j] +')'});
    }
    self.db.beginTransaction({statements: transStatement}, {commit:true}, function(err){
      // error message format: "Already constrained CONSTRAINT ON ( bike:Bike ) ASSERT bike.name IS UNIQUE."
      if(err){
        var filterConstraints = function(object){
          return object.statement !== 'CREATE CONSTRAINT ON (node:' + self.label + ') ASSERT node.' + field + ' IS UNIQUE';
        };
        var filterIndexes = function(object){
          return object.statement !== 'CREATE INDEX ON :' + self.label + '(' + field +')';
        };
        // if there is an array of errors focus on the first error
        if(Array.isArray(err)) {
          err = err[0];
        }
        var field, index;
        if(err.message && err.message.indexOf('Already constrained') !== -1){
          //remove the offending constraint
          field = err.message.slice(err.message.indexOf('.')+1, err.message.indexOf('IS')-1);
          self.schema._appliedConstraints.push(field);

          // remove offending constraint
          index = self.schema._constraints.indexOf(field);
          self.schema._constraints.splice(index, 1);

          //remove offending constraint from the _transactions list
          // self._statements = self._statements.filter(filterConstraints);

          self.applyIndexes(callback);
        }
        else if(err.message && err.message.indexOf('Already indexed') !== -1){
          //remove the offending index
          field = err.message.slice(err.message.indexOf('(')+1, err.message.indexOf(')'));

          // remove offending constraint
          index = self.schema._indexes.indexOf(field);
          if(index !== -1) {
            self.schema._indexes.splice(index, 1);

            self.schema._appliedIndexes.push(field);
          }
          else {
            index = self.schema._constraints.indexOf(field);
            self.schema._constraints.splice(index, 1);

            self.schema._appliedConstraints.push(field);
          }
          self.applyIndexes(callback);
        }
        else {
          return callback(new Neo4jError('Error applying Indexes: '+ JSON.stringify(err)));
        }
      }
      else {
        self.schema._appliedConstraints = self.schema._appliedConstraints.concat(self.schema._constraints);
        self.schema._appliedIndexes = self.schema._appliedIndexes.concat(self.schema._indexes);
        self.schema._constraints = [];
        self.schema._indexes = [];
        return callback(null);
      }
    });
  }
  else return callback(null);
};

Model.prototype.parseResults = function(results, options){
  var result = [];
  results.results[0].data.forEach(function(element, index){
    var node = results.results[0].data[index].row[1];
    node._id = results.results[0].data[index].row[0];

    // remove fields not required
    if(options && options.fields){
      var elements = options.fields.split(' ');
      for(var key in node){
        if(elements.indexOf(key) === -1) delete node[key];
      }
    }

    var rel = {};
    // if there is a relationship as well
    if(results.results[0].data[index].row[2]){
      rel.data = results.results[0].data[index].row[3];
      rel.type = results.results[0].data[index].row[2];
      rel._id = results.results[0].data[index].row[4];
    }

    var response;
    if(rel._id) {
      response = {
        node:node,
        rel: rel
      };
    }
    else {
      response = node;
    }

    result.push(response);
  });

  // findOne, findById should return a single value
  if(options && options.limit === 1) {
    // if (result.length > 0) {
      result = result[0];
    // }
    // else result = {};
  }
  return result;
};



var writeActions = require('./write');
Model.prototype.create = writeActions.create;
Model.prototype.update = writeActions.update;
Model.prototype.remove = writeActions.remove;
Model.prototype.createRelationship = writeActions.createRelationship;
Model.prototype.removeRelationship = writeActions.removeRelationship;


var readActions = require('./read');
Model.prototype.find = readActions.find;
Model.prototype.findById = readActions.findById;
Model.prototype.findOne = readActions.findOne;
Model.prototype.findByIdAndUpdate = readActions.findByIdAndUpdate;
Model.prototype.findOneAndUpdate = readActions.findOneAndUpdate;
Model.prototype.getRelationships = readActions.getRelationships;



module.exports = function(db) {
  return new ModelHolder(db);
};


// Tansaction.begin(function(err, transasction){
//  User.create(data, function(err, user){
//    // create another node
//      // create a relationship between them
//    // create an event
//      // link the event to a user
//      // link the event to another item
//  })
// })

'use strict';

var Vec3 = require('famous-math').Vec3;
var ObjectManager = require('famous-utilities').ObjectManager;

ObjectManager.register('Manifold', Manifold);
ObjectManager.register('Contact', Contact);
var OMRequestManifold = ObjectManager.requestManifold;
var OMRequestContact = ObjectManager.requestContact;
var OMFreeManifold = ObjectManager.freeManifold;
var OMFreeContact = ObjectManager.freeContact;

/**
 * Helper function to clamp a value to a given range.
 *
 * @method clamp
 * @param {Number} value
 * @param {Number} lower
 * @param {Number} upper
 * @return {Number}
 * @private
 */
function clamp(value, lower, upper) {
    return value < lower ? lower : value > upper ? upper : value;
}

var VEC1_REGISTER = new Vec3();
var VEC2_REGISTER = new Vec3();
var VB1_REGISTER = new Vec3();
var VB2_REGISTER = new Vec3();
var WxR_REGISTER = new Vec3();
var R1_REGISTER = new Vec3();
var R2_REGISTER = new Vec3();
var NORMALIMPULSE_REGISTER = new Vec3();
var TANGENTIMPULSE1_REGISTER = new Vec3();
var TANGENTIMPULSE2_REGISTER = new Vec3();
var WA_REGISTER = new Vec3();
var WB_REGISTER = new Vec3();
var PENETRATING_REGISTER = new Vec3();
var DRIFTA_REGISTER = new Vec3();
var DRIFTB_REGISTER = new Vec3();

/**
 * Table maintaining and managing current contact manifolds.
 *
 * @class ContactManifoldTable
 */
function ContactManifoldTable() {
    this.manifolds = [];
    this.collisionMatrix = {};
    this._IDPool = [];
}

/**
 * Create a new contact manifold. Tracked by the collisionMatrix according to
 * its low-high ordered ID pair.
 *
 * @method addManifold
 * @param {Number} lowId
 * @param {Number} highID
 * @param {Particle} bodyA
 * @param {Particle} bodyB
 * @return {ContactManifold}
 */
ContactManifoldTable.prototype.addManifold = function addManifold(lowID, highID, bodyA, bodyB) {
    var collisionMatrix = this.collisionMatrix;
    collisionMatrix[lowID] = collisionMatrix[lowID] || {};

    var index = this._IDPool.length ? this._IDPool.pop() : this.manifolds.length;
    this.collisionMatrix[lowID][highID] = index;
    var manifold = OMRequestManifold().reset(lowID, highID, bodyA, bodyB);
    this.manifolds[index] = manifold;

    return manifold;
};

/**
 * Remove a manifold and free it for later reuse.
 *
 * @method removeManifold
 * @param {ContactManifold} manifold
 * @param {Number} index
 */
ContactManifoldTable.prototype.removeManifold = function removeManifold(manifold, index) {
    var collisionMatrix = this.collisionMatrix;

    this.manifolds[index] = null;
    collisionMatrix[manifold.lowID][manifold.highID] = null;
    this._IDPool.push(index);

    OMFreeManifold(manifold);
};

/**
 * Update each of the manifolds, removing those that no longer contain contact points.
 *
 * @method update
 * @param {Number} dt
 */
ContactManifoldTable.prototype.update = function update(dt) {
    var manifolds = this.manifolds;
    for (var i = 0, len = manifolds.length; i < len; i++) {
        var manifold = manifolds[i];
        if (!manifold) continue;
        var persists = manifold.update(dt);
        if (!persists) {
            this.removeManifold(manifold, i);
            manifold.bodyA.events.trigger('collision:end', manifold);
            manifold.bodyB.events.trigger('collision:end', manifold);
        }
    }
};

/**
 * Warm start all Contacts, and perform precalculations needed in the iterative solver.
 *
 * @method prepContacts
 * @param {Number} dt
 */
ContactManifoldTable.prototype.prepContacts = function prepContacts(dt) {
    var manifolds = this.manifolds;
    for (var i = 0, len = manifolds.length; i < len; i++) {
        var manifold = manifolds[i];
        if (!manifold) continue;
        var contacts = manifold.contacts;
        for (var j = 0, lenj = contacts.length; j < lenj; j++) {
            var contact = contacts[j];
            if (!contact) continue;
            contact.update(dt);
        }
    }
};

/**
 * Resolve all contact manifolds.
 *
 * @method resolveManifolds
 */
ContactManifoldTable.prototype.resolveManifolds = function resolveManifolds() {
    var manifolds = this.manifolds;
    for (var i = 0, len = manifolds.length; i < len; i++) {
        var manifold = manifolds[i];
        if (!manifold) continue;
        manifold.resolveContacts();
    }
};

/**
 * Create a new Contact, also creating a new Manifold if one does not already exist for that pair.
 *
 * @method registerContact
 * @param {Body} bodyA
 * @param {Body} bodyB
 * @param {CollisionData} collisionData
 */
ContactManifoldTable.prototype.registerContact = function registerContact(bodyA, bodyB, collisionData) {
    var lowID;
    var highID;

    if (bodyA._ID < bodyB._ID) {
        lowID = bodyA._ID;
        highID = bodyB._ID;
    } else {
        lowID = bodyB._ID;
        highID = bodyA._ID;
    }

    var manifolds = this.manifolds;
    var collisionMatrix = this.collisionMatrix;
    var manifold;
    if (!collisionMatrix[lowID] || collisionMatrix[lowID][highID] == null) {
        manifold = this.addManifold(lowID, highID, bodyA, bodyB);
        manifold.addContact(bodyA, bodyB, collisionData);
        bodyA.events.trigger('collision:start', manifold);
        bodyB.events.trigger('collision:start', manifold);
    } else {
        manifold = manifolds[ collisionMatrix[lowID][highID] ];
        manifold.contains(collisionData);
        manifold.addContact(bodyA, bodyB, collisionData);
    }
};

var THRESHOLD = 10;

/**
 * Class to keep track of Contact points.
 * @class manifold
 * @param {Number} lowId
 * @param {Number} highId
 * @param {Body} bodyA
 * @param {Body} bodyB
 */
function Manifold(lowID, highID, bodyA, bodyB) {
    this.lowID = lowID;
    this.highID = highID;

    this.contacts = [];
    this.numContacts = 0;

    this.bodyA = bodyA;
    this.bodyB = bodyB;

    this.lru = 0;
}

/**
 * Used by ObjectManager to reset the object with different data.
 *
 * @method reset
 * @param {Object[]} args
 * @chainable
 */
Manifold.prototype.reset = function reset(lowID, highID, bodyA, bodyB) {
    this.lowID = lowID;
    this.highID = highID;

    this.contacts = [];
    this.numContacts = 0;

    this.bodyA = bodyA;
    this.bodyB = bodyB;

    this.lru = 0;

    return this;
};

/**
 * Create a new Contact point and add it to the Manifold.
 *
 * @method addContact
 * @param {Body} bodyA
 * @param {Body} bodyB
 * @param {CollisionData} collisionData
 */
Manifold.prototype.addContact = function addContact(bodyA, bodyB, collisionData) {
    var index = this.lru;
    if (this.contacts[index]) this.removeContact(this.contacts[index], index);
    this.contacts[index] = OMRequestContact().reset(bodyA, bodyB, collisionData);
    this.lru = (this.lru + 1) % 4;
    this.numContacts++;
};

/**
 * Remove and free a Contact for later reuse.
 *
 * @method removeContact
 * @param {Contact} contact
 * @param {Number} index
 */
Manifold.prototype.removeContact = function removeContact(contact, index) {
    this.contacts[index] = null;
    this.numContacts--;

    ObjectManager.freeCollisionData(contact.data);
    contact.data = null;
    OMFreeContact(contact);
};

/**
 * Check if a Contact already exists for the collision data within a certain tolerance.
 * If found, remove the Contact.
 *
 * @method contains
 * @param {CollisionData} collisionData
 * @return {Boolean}
 */
Manifold.prototype.contains = function contains(collisionData) {
    var wA = collisionData.worldContactA;
    var wB = collisionData.worldContactB;

    var contacts = this.contacts;
    for (var i = 0, len = contacts.length; i < len; i++) {
        var contact = contacts[i];
        if (!contact) continue;
        var data = contact.data;
        var distA = Vec3.subtract(data.worldContactA, wA, DRIFTA_REGISTER).length();
        var distB = Vec3.subtract(data.worldContactB, wB, DRIFTB_REGISTER).length();

        if (distA < THRESHOLD || distB < THRESHOLD) {
            this.removeContact(contact, i);
            return true;
        }
    }

    return false;
};

/**
 * Remove Contacts the local points of which have drifted above a certain tolerance.
 * Return true or false to indicate that the Manifold still contains at least one Contact.
 *
 * @method update
 * @param {Number} dt
 * @return {Boolean} whether or not the manifold persists
 */
Manifold.prototype.update = function update(dt) {
    var contacts = this.contacts;
    var bodyA = this.bodyA;
    var bodyB = this.bodyB;

    var posA = bodyA.position;
    var posB = bodyB.position;

    for (var i = 0, len = contacts.length; i < len; i++) {
        var contact = contacts[i];
        if (!contact) continue;
        var data = contact.data;
        var n = data.normal;
        var rA = data.localContactA;
        var rB = data.localContactB;

        var cached_wA = data.worldContactA;
        var cached_wB = data.worldContactB;

        var wA = Vec3.add(posA, rA, WA_REGISTER);
        var wB = Vec3.add(posB, rB, WB_REGISTER);

        var notPenetrating = Vec3.dot(Vec3.subtract(wB, wA, PENETRATING_REGISTER), n) > 0;

        var driftA = Vec3.subtract(cached_wA, wA, DRIFTA_REGISTER);
        var driftB = Vec3.subtract(cached_wB, wB, DRIFTB_REGISTER);


        if (driftA.length() >= THRESHOLD || driftB.length() >= THRESHOLD || notPenetrating) {
            this.removeContact(contact, i);
        }
    }

    if (this.numContacts) return true;
    else return false;
};

/**
 * Resolve all contacts.
 *
 * @method resolveContacts
 */
Manifold.prototype.resolveContacts = function resolveContacts() {
    var contacts = this.contacts;
    for (var i = 0, len = contacts.length; i < len; i++) {
        if (!contacts[i]) continue;
        contacts[i].resolve();
    }
};

/**
 * Class to maintain collision data between two bodies.
 * The end of the resolve chain, and where the actual impulses are applied.
 *
 * @class Contact
 * @param {Body} bodyA
 * @param {Body} bodyB
 * @param {CollisionData} collisionData
 */
function Contact(bodyA, bodyB, collisionData) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.data = collisionData;

    this.normalImpulse = 0;
    this.tangentImpulse1 = 0;
    this.tangentImpulse2 = 0;

    this.impulse = new Vec3();
    this.angImpulseA = new Vec3();
    this.angImpulseB = new Vec3();

    if (collisionData) this.init();
}

/**
 * Used by ObjectManager to reset the object with different data.
 *
 * @method reset
 * @param {Object[]} args
 * @chainable
 */
Contact.prototype.reset = function reset(bodyA, bodyB, collisionData) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.data = collisionData;

    this.normalImpulse = 0;
    this.tangentImpulse1 = 0;
    this.tangentImpulse2 = 0;

    this.impulse.clear();
    this.angImpulseA.clear();
    this.angImpulseB.clear();

    this.init();

    return this;
};

/**
 * Initialization method called on instantiantion or reset of the Contact. Performs
 * precalculations that will not change over the life of the Contact.
 *
 * @method init
 */
Contact.prototype.init = function init() {
    var data = this.data;
    var n = data.normal;
    var t1 = new Vec3();
    if (n.x >= 0.57735) {
        t1.set(n.y, -n.x, 0);
    } else {
        t1.set(0, n.z, -n.y);
    }
    t1.normalize();
    var t2 = Vec3.cross(n, t1, new Vec3());

    this.tangent1 = t1;
    this.tangent2 = t2;

    var bodyA = this.bodyA;
    var bodyB = this.bodyB;

    var rBodyA = data.localContactA;
    var rBodyB = data.localContactB;

    var invEffectiveMass = bodyA.inverseMass + bodyB.inverseMass;

    var r1n = Vec3.cross(rBodyA, n, R1_REGISTER);
    var r2n = Vec3.cross(rBodyB, n, R2_REGISTER);
    this.effNormalMass = 1 / (invEffectiveMass +
        Vec3.dot(r1n, bodyA.inverseInertia.vectorMultiply(r1n, VEC1_REGISTER)) +
        Vec3.dot(r2n, bodyB.inverseInertia.vectorMultiply(r2n, VEC1_REGISTER)));

    var r1t1 = Vec3.cross(rBodyA, t1, R1_REGISTER);
    var r2t1 = Vec3.cross(rBodyB, t1, R2_REGISTER);
    this.effTangentialMass1 = 1 / (invEffectiveMass +
        Vec3.dot(r1t1, bodyA.inverseInertia.vectorMultiply(r1t1, VEC1_REGISTER)) +
         Vec3.dot(r2t1, bodyB.inverseInertia.vectorMultiply(r2t1, VEC1_REGISTER)));

    var r1t2 = Vec3.cross(rBodyA, t2, R1_REGISTER);
    var r2t2 = Vec3.cross(rBodyB, t2, R2_REGISTER);
    this.effTangentialMass2 = 1 / (invEffectiveMass +
        Vec3.dot(r1t2, bodyA.inverseInertia.vectorMultiply(r1t2, VEC1_REGISTER)) +
         Vec3.dot(r2t2, bodyB.inverseInertia.vectorMultiply(r2t2, VEC1_REGISTER)));

    this.restitution = Math.min(bodyA.restitution, bodyB.restitution);
    this.friction = bodyA.friction * bodyB.friction;
}

/**
 * Warm start the Contact, prepare for the iterative solver, and reset impulses.
 *
 * @method update
 * @param {Number} dt
 */
Contact.prototype.update = function update(dt) {
    var data = this.data;
    var bodyA = this.bodyA;
    var bodyB = this.bodyB;

    var rBodyA = data.localContactA;
    var rBodyB = data.localContactB;

    var n = data.normal;

    var vb1 = Vec3.add(bodyA.velocity, Vec3.cross(bodyA.angularVelocity, rBodyA, WxR_REGISTER), VB1_REGISTER);
    var vb2 = Vec3.add(bodyB.velocity, Vec3.cross(bodyB.angularVelocity, rBodyB, WxR_REGISTER), VB2_REGISTER);
    var relativeVelocity = vb2.subtract(vb1);
    var contactSpeed = Vec3.dot(relativeVelocity, n);

    var beta = 0.15;
    var slop = 1.5;
    var velocityTolerance = 20.0;

    var restitution = Math.abs(contactSpeed) < velocityTolerance ? 0.0 : this.restitution;
    this.velocityBias = -beta * Math.max(data.penetration - slop, 0.0) / dt;
    this.velocityBias += restitution * contactSpeed;

    var impulse = this.impulse.scale(0.25);
    var angImpulseA = this.angImpulseA.scale(0.25);
    var angImpulseB = this.angImpulseB.scale(0.25);

    bodyB.applyImpulse(impulse);
    bodyB.applyAngularImpulse(angImpulseB);
    impulse.invert();
    bodyA.applyImpulse(impulse);
    bodyA.applyAngularImpulse(angImpulseA);

    this.normalImpulse = 0;
    this.tangentImpulse1 = 0;
    this.tangentImpulse2 = 0;

    impulse.clear();
    angImpulseA.clear();
    angImpulseB.clear();
};

/**
 * Apply impulses to resolve the contact and simulate friction.
 *
 * @method resolve
 */
Contact.prototype.resolve = function resolve() {
    var data = this.data;
    var bodyA = this.bodyA;
    var bodyB = this.bodyB;

    var rBodyA = data.localContactA;
    var rBodyB = data.localContactB;

    var n = data.normal;
    var t1 = this.tangent1;
    var t2 = this.tangent2;

    var vb1 = Vec3.add(bodyA.velocity, Vec3.cross(bodyA.angularVelocity, rBodyA, WxR_REGISTER), VB1_REGISTER);
    var vb2 = Vec3.add(bodyB.velocity, Vec3.cross(bodyB.angularVelocity, rBodyB, WxR_REGISTER), VB2_REGISTER);
    var relativeVelocity = vb2.subtract(vb1);

    var normalLambda = -(Vec3.dot(relativeVelocity, n) + this.velocityBias) * this.effNormalMass;
    var newNormalImpulse = Math.max(this.normalImpulse + normalLambda, 0);
    normalLambda = newNormalImpulse - this.normalImpulse;

    var maxFriction = this.friction * newNormalImpulse;

    var tangentLambda1 = -Vec3.dot(relativeVelocity, t1) * this.effTangentialMass1;
    var newTangentImpulse1 = clamp(this.tangentImpulse1 + tangentLambda1, -maxFriction, maxFriction);
    tangentLambda1 = newTangentImpulse1 - this.tangentImpulse1;

    var tangentLambda2 = -Vec3.dot(relativeVelocity, t2) * this.effTangentialMass2;
    var newTangentImpulse2 = clamp(this.tangentImpulse2 + tangentLambda2, -maxFriction, maxFriction);
    tangentLambda2 = newTangentImpulse2 - this.tangentImpulse2;

    var impulse = Vec3.scale(n, normalLambda, NORMALIMPULSE_REGISTER);
    var tangentImpulse1 = Vec3.scale(t1, tangentLambda1, TANGENTIMPULSE1_REGISTER);
    var tangentImpulse2 = Vec3.scale(t2, tangentLambda2, TANGENTIMPULSE2_REGISTER);

    impulse.add(tangentImpulse1).add(tangentImpulse2);

    var angImpulseB = Vec3.cross(rBodyB, impulse, VEC1_REGISTER);
    var angImpulseA = Vec3.cross(rBodyA, impulse, VEC2_REGISTER).invert();

    bodyB.applyImpulse(impulse);
    bodyB.applyAngularImpulse(angImpulseB);
    impulse.invert();
    bodyA.applyImpulse(impulse);
    bodyA.applyAngularImpulse(angImpulseA);

    this.normalImpulse = newNormalImpulse;
    this.tangentImpulse1 = newTangentImpulse1;
    this.tangentImpulse2 = newTangentImpulse2;

    this.impulse.add(impulse);
    this.angImpulseA.add(angImpulseA);
    this.angImpulseB.add(angImpulseB);
};

module.exports = ContactManifoldTable;
